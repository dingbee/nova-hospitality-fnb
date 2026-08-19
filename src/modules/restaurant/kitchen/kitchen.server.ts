/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Kitchen operations.
 *
 * Firing an order turns sold lines into station tickets. Every state change is
 * timestamped, so preparation time and service delay are *measured*, never
 * estimated. A ticket that breaches its station target emits a delay fact the
 * Intelligence Core can reason over.
 */
import { z } from "zod";
import type {
  AdvanceTicketInput,
  FireOrderInput,
  listStationsSchema,
  listTicketsSchema,
  upsertStationSchema,
} from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";

type Sb = any;

export async function listStations(sb: Sb, userId: string, input: z.infer<typeof listStationsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_stations")
    .select("id, code, name, station_type, target_prep_minutes, sort_order, active, location_id")
    .eq("tenant_id", input.tenantId)
    .order("sort_order");
  if (input.locationId) q = q.eq("location_id", input.locationId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertStation(sb: Sb, userId: string, input: z.infer<typeof upsertStationSchema>) {
  await assertCapability(sb, userId, input.tenantId, "kitchen.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    code: input.code,
    name: input.name,
    station_type: input.stationType,
    target_prep_minutes: input.targetPrepMinutes,
    sort_order: input.sortOrder,
    active: input.active,
  };
  const q = input.id
    ? sb.from("restaurant_stations").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_stations").insert(row);
  const { data, error } = await q.select("id, code, name, target_prep_minutes").single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listTickets(sb: Sb, userId: string, input: z.infer<typeof listTicketsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_kitchen_tickets")
    .select(
      "id, ticket_number, order_id, station_id, status, priority, course, target_minutes, queued_at, started_at, ready_at, served_at, prep_seconds, delay_seconds, is_delayed, notes",
    )
    .eq("tenant_id", input.tenantId)
    .order("priority", { ascending: false })
    .order("queued_at")
    .limit(input.limit);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.stationId) q = q.eq("station_id", input.stationId);
  if (input.status) q = q.eq("status", input.status);
  if (input.openOnly) q = q.in("status", ["queued", "preparing", "ready"]);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const tickets = (data ?? []) as any[];
  if (tickets.length === 0) return [];
  const { data: items } = await sb
    .from("restaurant_kitchen_ticket_items")
    .select("id, ticket_id, description, quantity, status, notes")
    .eq("tenant_id", input.tenantId)
    .in("ticket_id", tickets.map((t) => t.id));

  const now = Date.now();
  return tickets.map((t) => {
    const elapsed = Math.round((now - new Date(t.queued_at).getTime()) / 1000);
    return {
      ...t,
      elapsed_seconds: elapsed,
      /** Live breach flag for open tickets; the stored flag covers closed ones. */
      breaching: t.status === "queued" || t.status === "preparing" ? elapsed > t.target_minutes * 60 : t.is_delayed,
      items: ((items ?? []) as any[]).filter((i) => i.ticket_id === t.id),
    };
  });
}

/** One ticket per station, so each section owns its own queue. */
export async function fireOrder(sb: Sb, userId: string, input: FireOrderInput) {
  await assertCapability(sb, userId, input.tenantId, "kitchen.manage");

  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, location_id, property_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .single();
  if (!order) throw new Error("Order not found.");
  if (["closed", "cancelled", "voided"].includes(order.status)) {
    throw new Error("A closed order cannot be fired to the kitchen.");
  }

  let itemQuery = sb
    .from("restaurant_order_items")
    .select("id, menu_item_id, station_id, description, quantity, course, notes, status")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", input.orderId);
  if (input.orderItemIds.length > 0) itemQuery = itemQuery.in("id", input.orderItemIds);
  const { data: itemRows } = await itemQuery;

  const items = ((itemRows ?? []) as any[]).filter((i) => i.status === "ordered");
  if (items.length === 0) return { tickets: [], fired: 0 };

  const { data: stations } = await sb
    .from("restaurant_stations")
    .select("id, target_prep_minutes")
    .eq("tenant_id", input.tenantId);
  const targets = new Map<string, number>(((stations ?? []) as any[]).map((s) => [s.id, Number(s.target_prep_minutes)]));

  const groups = new Map<string, any[]>();
  for (const item of items) {
    const key = item.station_id ?? "unassigned";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const created: any[] = [];
  for (const [stationKey, group] of groups) {
    const stationId = stationKey === "unassigned" ? null : stationKey;
    const target = stationId ? (targets.get(stationId) ?? 15) : 15;
    const { data: ticket, error } = await sb
      .from("restaurant_kitchen_tickets")
      .insert({
        tenant_id: input.tenantId,
        order_id: input.orderId,
        station_id: stationId,
        location_id: order.location_id,
        ticket_number: `KOT-${order.order_number.split("-").slice(-1)[0]}-${created.length + 1}`,
        status: "queued",
        priority: input.priority,
        course: group[0]?.course ?? null,
        target_minutes: target,
      })
      .select("id, ticket_number, station_id, status, target_minutes, queued_at")
      .single();
    if (error) throw new Error(error.message);

    const { error: itemError } = await sb.from("restaurant_kitchen_ticket_items").insert(
      group.map((i) => ({
        tenant_id: input.tenantId,
        ticket_id: ticket.id,
        order_item_id: i.id,
        menu_item_id: i.menu_item_id,
        description: i.description,
        quantity: i.quantity,
        notes: i.notes,
      })),
    );
    if (itemError) throw new Error(itemError.message);

    await sb
      .from("restaurant_order_items")
      .update({ status: "fired" })
      .eq("tenant_id", input.tenantId)
      .in("id", group.map((i) => i.id));

    created.push(ticket);
  }

  await sb
    .from("restaurant_orders")
    .update({ status: "sent" })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .eq("status", "open");

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.kitchen.ticket.fired",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: order.id,
    source: "restaurant-os",
    payload: { order_number: order.order_number, tickets: created.length, items: items.length },
  });
  return { tickets: created, fired: items.length };
}

const NEXT_ITEM_STATUS: Record<string, string> = {
  ready: "ready",
  served: "served",
  cancelled: "cancelled",
  preparing: "preparing",
  queued: "queued",
};

export async function advanceTicket(sb: Sb, userId: string, input: AdvanceTicketInput) {
  await assertCapability(sb, userId, input.tenantId, "kitchen.manage");

  const { data: ticket } = await sb
    .from("restaurant_kitchen_tickets")
    .select("id, ticket_number, order_id, station_id, location_id, status, target_minutes, queued_at, started_at, ready_at")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.ticketId)
    .single();
  if (!ticket) throw new Error("Ticket not found.");

  const now = new Date();
  const patch: Record<string, unknown> = { status: input.status };
  if (input.notes) patch.notes = input.notes;
  if (input.status === "preparing" && !ticket.started_at) patch.started_at = now.toISOString();

  let delaySeconds = 0;
  let prepSeconds: number | null = null;
  if (input.status === "ready") {
    patch.ready_at = now.toISOString();
    prepSeconds = Math.max(0, Math.round((now.getTime() - new Date(ticket.queued_at).getTime()) / 1000));
    delaySeconds = Math.max(0, prepSeconds - ticket.target_minutes * 60);
    patch.prep_seconds = prepSeconds;
    patch.delay_seconds = delaySeconds;
    patch.is_delayed = delaySeconds > 0;
  }
  if (input.status === "served") patch.served_at = now.toISOString();

  const { data: updated, error } = await sb
    .from("restaurant_kitchen_tickets")
    .update(patch)
    .eq("tenant_id", input.tenantId)
    .eq("id", input.ticketId)
    .select("id, ticket_number, status, prep_seconds, delay_seconds, is_delayed, target_minutes")
    .single();
  if (error) throw new Error(error.message);

  await sb
    .from("restaurant_kitchen_ticket_items")
    .update({ status: NEXT_ITEM_STATUS[input.status] ?? input.status })
    .eq("tenant_id", input.tenantId)
    .eq("ticket_id", input.ticketId);

  if (input.status === "ready") {
    await emitRestaurantEvent(sb, userId, {
      type: delaySeconds > 0 ? "restaurant.kitchen.ticket.delayed" : "restaurant.kitchen.ticket.ready",
      tenantId: input.tenantId,
      locationId: ticket.location_id ?? undefined,
      entityType: "restaurant_kitchen_ticket",
      entityId: ticket.id,
      source: "restaurant-os",
      payload: {
        ticket_number: ticket.ticket_number,
        station_id: ticket.station_id,
        prep_seconds: prepSeconds,
        target_seconds: ticket.target_minutes * 60,
        delay_seconds: delaySeconds,
      },
      dedupeKey: `ticket-ready:${ticket.id}`,
    });

    // Bar mirror: a delayed beverage ticket is a bar service fact.
    if (delaySeconds > 0 && ticket.station_id) {
      const { data: station } = await sb
        .from("restaurant_stations")
        .select("station_type, name")
        .eq("tenant_id", input.tenantId)
        .eq("id", ticket.station_id)
        .maybeSingle();
      const barTypes = ["bar", "cocktail", "coffee", "service_bar", "beverage"];
      if (station && barTypes.includes(String(station.station_type))) {
        await emitRestaurantEvent(sb, userId, {
          type: "bar.ticket.delayed",
          tenantId: input.tenantId,
          locationId: ticket.location_id ?? undefined,
          entityType: "restaurant_kitchen_ticket",
          entityId: ticket.id,
          source: "restaurant-os",
          payload: {
            ticket_number: ticket.ticket_number,
            station_id: ticket.station_id,
            station_name: station.name,
            prep_seconds: prepSeconds,
            delay_seconds: delaySeconds,
          },
          dedupeKey: `bar:ticket-delayed:${ticket.id}`,
        });
      }
    }
  }
  return updated;
}

/** Station-level service performance over a window. Read-only. */
export async function stationPerformance(sb: Sb, userId: string, tenantId: string, since?: string) {
  await assertTenantRead(sb, userId, tenantId);
  const from = since ?? new Date(Date.now() - 7 * 864e5).toISOString();
  const [{ data: tickets }, { data: stations }] = await Promise.all([
    sb
      .from("restaurant_kitchen_tickets")
      .select("station_id, prep_seconds, delay_seconds, is_delayed, status")
      .eq("tenant_id", tenantId)
      .gte("queued_at", from),
    sb.from("restaurant_stations").select("id, name, target_prep_minutes").eq("tenant_id", tenantId),
  ]);

  const byStation = new Map<string, { total: number; delayed: number; prep: number[] }>();
  for (const t of ((tickets ?? []) as any[])) {
    if (t.prep_seconds == null) continue;
    const key = t.station_id ?? "unassigned";
    const agg = byStation.get(key) ?? { total: 0, delayed: 0, prep: [] };
    agg.total += 1;
    if (t.is_delayed) agg.delayed += 1;
    agg.prep.push(Number(t.prep_seconds));
    byStation.set(key, agg);
  }

  return ((stations ?? []) as any[]).map((s) => {
    const agg = byStation.get(s.id) ?? { total: 0, delayed: 0, prep: [] };
    const avg = agg.prep.length > 0 ? agg.prep.reduce((a, b) => a + b, 0) / agg.prep.length : 0;
    return {
      station_id: s.id,
      name: s.name,
      target_minutes: Number(s.target_prep_minutes),
      tickets: agg.total,
      delayed: agg.delayed,
      on_time_percent: agg.total > 0 ? Number((((agg.total - agg.delayed) / agg.total) * 100).toFixed(1)) : null,
      avg_prep_minutes: Number((avg / 60).toFixed(1)),
    };
  });
}
