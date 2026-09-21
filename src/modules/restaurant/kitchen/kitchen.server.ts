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
import {
  assertCapability,
  assertTenantRead,
  accessibleLocationIds,
  accessiblePropertyIds,
  accessibleStationIds,
  getTenantScope,
} from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { BAR_STATION_TYPES } from "../bar/contracts";
import { groupItemsByStation } from "./grouping";

type Sb = any;

export async function listStations(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listStationsSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "kitchen.manage", {
    propertyId: input.propertyId,
    locationId: input.locationId,
  });

  const scope = await getTenantScope(sb, userId, input.tenantId);
  const allowedLocationIds = await accessibleLocationIds(sb, scope);
  const allowedPropertyIds = accessiblePropertyIds(scope);
  const assignedStationIds = await accessibleStationIds(sb, userId, scope);

  let q = sb
    .from("restaurant_stations")
    .select(
      "id, code, name, station_type, target_prep_minutes, sort_order, active, location_id, property_id",
    )
    .eq("tenant_id", input.tenantId)
    .order("sort_order");
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.propertyId) q = q.eq("property_id", input.propertyId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  // The DB/RLS layer remains the security boundary. This application-layer
  // narrowing makes the operational workspace deterministic as well: a
  // property-scoped chef/manager never receives another property's stations.
  return ((data ?? []) as any[]).filter((s) => {
    if (assignedStationIds !== null && !assignedStationIds.includes(s.id)) return false;
    if (allowedPropertyIds === null) return true;
    if (allowedPropertyIds.length === 0) return false;
    if (s.property_id && allowedPropertyIds.includes(s.property_id)) return true;
    return Boolean(s.location_id && allowedLocationIds?.includes(s.location_id));
  });
}

export async function upsertStation(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertStationSchema>,
) {
  // On update, authorize both the station's existing scope and the proposed
  // destination. This prevents a property-scoped operator from editing a
  // station they do not own simply by omitting/changing the scope fields.
  if (input.id) {
    const { data: existing } = await sb
      .from("restaurant_stations")
      .select("property_id, location_id")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.id)
      .maybeSingle();
    if (!existing) throw new Error("Station not found.");
    await assertCapability(sb, userId, input.tenantId, "kitchen.manage", {
      propertyId: existing.property_id,
      locationId: existing.location_id,
    });
  }

  await assertCapability(sb, userId, input.tenantId, "kitchen.manage", {
    propertyId: input.propertyId,
    locationId: input.locationId,
  });

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

export async function listTickets(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listTicketsSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "kitchen.manage", {
    propertyId: input.propertyId,
    locationId: input.locationId,
  });

  const scope = await getTenantScope(sb, userId, input.tenantId);
  const allowedLocationIds = await accessibleLocationIds(sb, scope);
  const assignedStationIds = await accessibleStationIds(sb, userId, scope);
  if (allowedLocationIds !== null && allowedLocationIds.length === 0) return [];

  // An explicit empty list ("scope to these stations" with none given, e.g.
  // a tenant with no kitchen-type stations configured yet) means "match no
  // station", not "no filter" — falling through to unfiltered here would
  // silently show every other station's tickets on a board scoped to none.
  if (input.stationIds && input.stationIds.length === 0) return [];
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
  if (input.propertyId) {
    const { data: propertyLocations } = await sb
      .from("restaurant_locations")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .eq("property_id", input.propertyId);
    const ids = ((propertyLocations ?? []) as any[]).map((r) => r.id);
    if (ids.length === 0) return [];
    q = q.in("location_id", ids);
  } else if (allowedLocationIds !== null) {
    q = q.in("location_id", allowedLocationIds);
  }
  if (input.stationId) {
    if (assignedStationIds !== null && !assignedStationIds.includes(input.stationId)) return [];
    q = q.eq("station_id", input.stationId);
  } else if (assignedStationIds !== null) {
    if (assignedStationIds.length === 0) return [];
    q = q.in("station_id", assignedStationIds);
  }

  // Defense in depth: the Kitchen board must never read a bar station even
  // if a stale client sends a mixed/incorrect stationIds list. The routing
  // classifier is server-authoritative here, not just a UI convention.
  if (input.stationIds) {
    const { data: scopedStations, error: stationError } = await sb
      .from("restaurant_stations")
      .select("id, station_type")
      .eq("tenant_id", input.tenantId)
      .in("id", input.stationIds);

    if (stationError) throw new Error(stationError.message);

    const barTypes = new Set(BAR_STATION_TYPES.map((t) => t.trim().toLowerCase()));
    let kitchenStationIds = ((scopedStations ?? []) as any[])
      .filter((s) => !barTypes.has(String(s.station_type ?? "").trim().toLowerCase()))
      .map((s) => s.id);

    if (assignedStationIds !== null) {
      kitchenStationIds = kitchenStationIds.filter((id: string) => assignedStationIds.includes(id));
    }
    if (kitchenStationIds.length === 0) return [];
    q = q.in("station_id", kitchenStationIds);
  }

  if (input.status) q = q.eq("status", input.status);
  if (input.openOnly) q = q.in("status", ["queued", "preparing", "ready"]);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const tickets = (data ?? []) as any[];
  if (tickets.length === 0) return [];
  const orderIds = [...new Set(tickets.map((t) => t.order_id).filter(Boolean))];
  const [{ data: items }, { data: orders }] = await Promise.all([
    sb
      .from("restaurant_kitchen_ticket_items")
      .select("id, ticket_id, description, quantity, status, notes, order_item_id")
      .eq("tenant_id", input.tenantId)
      .in(
        "ticket_id",
        tickets.map((t) => t.id),
      ),
    // A ticket carries order_id but nothing an operator can actually place
    // on the floor with — "table 12" is what matters at the pass, not the
    // order id. One extra lookup, not one per ticket.
    orderIds.length > 0
      ? sb
          .from("restaurant_orders")
          .select("id, order_number, table_id")
          .eq("tenant_id", input.tenantId)
          .in("id", orderIds)
      : Promise.resolve({ data: [] }),
  ]);
  const orderRows = (orders ?? []) as any[];
  const tableIds = [...new Set(orderRows.map((o) => o.table_id).filter(Boolean))];
  const { data: tables } =
    tableIds.length > 0
      ? await sb
          .from("restaurant_tables")
          .select("id, code")
          .eq("tenant_id", input.tenantId)
          .in("id", tableIds)
      : { data: [] };
  const tableCodeById = new Map(((tables ?? []) as any[]).map((tb) => [tb.id, tb.code]));
  const orderById = new Map(
    orderRows.map((o) => [
      o.id,
      {
        order_number: o.order_number,
        table_code: o.table_id ? (tableCodeById.get(o.table_id) ?? null) : null,
      },
    ]),
  );

  // Ticket items don't carry modifiers themselves — the guest's chosen
  // modifiers live on the order item they were fired from. One batch lookup
  // (same "not one per ticket" pattern as the order/table lookups above) so
  // the pass can show "no ice, extra spicy" instead of just the item name.
  const orderItemIds = [
    ...new Set(((items ?? []) as any[]).map((i) => i.order_item_id).filter(Boolean)),
  ];
  const { data: orderItemRows } =
    orderItemIds.length > 0
      ? await sb
          .from("restaurant_order_items")
          .select("id, modifiers")
          .eq("tenant_id", input.tenantId)
          .in("id", orderItemIds)
      : { data: [] };
  const modifiersByOrderItemId = new Map(
    ((orderItemRows ?? []) as any[]).map((oi) => [oi.id, oi.modifiers ?? []]),
  );

  const now = Date.now();
  return tickets.map((t) => {
    const elapsed = Math.round((now - new Date(t.queued_at).getTime()) / 1000);
    return {
      ...t,
      elapsed_seconds: elapsed,
      /** Live breach flag for open tickets; the stored flag covers closed ones. */
      breaching:
        t.status === "queued" || t.status === "preparing"
          ? elapsed > t.target_minutes * 60
          : t.is_delayed,
      items: ((items ?? []) as any[])
        .filter((i) => i.ticket_id === t.id)
        .map((i) => ({
          ...i,
          modifiers: i.order_item_id ? (modifiersByOrderItemId.get(i.order_item_id) ?? []) : [],
        })),
      order_number: orderById.get(t.order_id)?.order_number ?? null,
      table_code: orderById.get(t.order_id)?.table_code ?? null,
    };
  });
}

/**
 * One ticket per station, so each section owns its own queue. Extracted from
 * fireOrder so a caller with no staff principal to check a capability
 * against (self-order submission — see selforder.server.ts) can still fire
 * an order's own just-created lines through the exact same ticket-creation
 * logic, rather than a second, parallel implementation of it.
 */
async function fireOrderItemsCore(
  sb: Sb,
  input: { tenantId: string; orderId: string; orderItemIds: string[]; priority: number },
) {
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
  const targets = new Map<string, number>(
    ((stations ?? []) as any[]).map((s) => [s.id, Number(s.target_prep_minutes)]),
  );

  const groups = groupItemsByStation(items);

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
      .in(
        "id",
        group.map((i) => i.id),
      );

    created.push(ticket);
  }

  await sb
    .from("restaurant_orders")
    .update({ status: "sent" })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .eq("status", "open");

  return {
    tickets: created,
    fired: items.length,
    orderNumber: order.order_number as string,
    propertyId: (order.property_id as string | null) ?? null,
    locationId: (order.location_id as string | null) ?? null,
  };
}

/** Staff-invoked: fires an order's un-fired lines to the kitchen/bar. */
export async function fireOrder(sb: Sb, userId: string, input: FireOrderInput) {
  // The order carries the authoritative property/location. A property-scoped
  // operator may fire only an order belonging to their own operational scope.
  const { data: orderScope } = await sb
    .from("restaurant_orders")
    .select("property_id, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .maybeSingle();
  if (!orderScope) throw new Error("Order not found.");
  await assertCapability(sb, userId, input.tenantId, "kitchen.manage", {
    propertyId: orderScope.property_id,
    locationId: orderScope.location_id,
  });
  const result = await fireOrderItemsCore(sb, input);

  if (result.fired > 0) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.kitchen.ticket.fired",
      tenantId: input.tenantId,
      propertyId: result.propertyId ?? undefined,
      locationId: result.locationId ?? undefined,
      entityType: "restaurant_order",
      entityId: input.orderId,
      source: "restaurant-os",
      payload: {
        order_number: result.orderNumber,
        tickets: result.tickets.length,
        items: result.fired,
      },
    });
  }
  return { tickets: result.tickets, fired: result.fired };
}

/**
 * Guest-safe entry point: fires a self-order's own just-created lines with
 * no staff capability check, since a guest has no staff principal to check
 * one against — the same boundary insertLines/createGuestOrder already draw
 * for writing the lines themselves. Never throws into the caller: a firing
 * hiccup must not fail the guest's order submission, which already
 * succeeded and is the record that matters. The order simply stays "open"
 * for a staff member to fire manually from the kitchen/POS screen, exactly
 * like it does today for every order this path doesn't reach.
 */
export async function fireGuestOrder(
  sb: Sb,
  input: { tenantId: string; orderId: string },
): Promise<{ fired: number } | { fired: 0; error: string }> {
  try {
    const result = await fireOrderItemsCore(sb, {
      tenantId: input.tenantId,
      orderId: input.orderId,
      orderItemIds: [],
      priority: 0,
    });
    return { fired: result.fired };
  } catch (err) {
    return { fired: 0, error: (err as Error).message };
  }
}

const NEXT_ITEM_STATUS: Record<string, string> = {
  ready: "ready",
  served: "served",
  cancelled: "cancelled",
  preparing: "preparing",
  queued: "queued",
};

/**
 * Cancels the kitchen/bar ticket item(s) fired for order lines that are being
 * voided or cancelled off the bill.
 *
 * voidPosLine and cancelOrder correct the bill and the stock ledger, but
 * neither ever touched restaurant_kitchen_ticket_items — a line voided after
 * being fired left its ticket item sitting at queued/preparing/ready
 * indefinitely: a phantom production ticket kitchen/bar staff kept working
 * from (or a guest's own tracker kept showing progress on) for a line that
 * no longer exists on the bill. This is the missing sync between the two.
 *
 * A ticket item already `served` is left untouched — the dish was actually
 * made and delivered, so a later void is a financial correction on the
 * record, never a rewrite of service history (the same principle
 * voidPosLine's own doc comment states for the bill itself). Already
 * `cancelled` items are left alone too, so this is safe to call more than
 * once for the same order items.
 */
export async function cancelKitchenTicketItemsForOrderItems(
  sb: Sb,
  tenantId: string,
  orderItemIds: string[],
): Promise<{ cancelled: number }> {
  if (orderItemIds.length === 0) return { cancelled: 0 };
  const { data, error } = await sb
    .from("restaurant_kitchen_ticket_items")
    .update({ status: "cancelled" })
    .eq("tenant_id", tenantId)
    .in("order_item_id", orderItemIds)
    .not("status", "in", "(served,cancelled)")
    .select("id");
  if (error) throw new Error(error.message);
  return { cancelled: ((data ?? []) as any[]).length };
}

/**
 * Legal ticket-status transitions, enforced here rather than trusted from
 * the UI. The Kitchen board only ever offers the single next status as a
 * button (queued -> preparing -> ready -> served), but that is UI-only
 * protection: a stale client (a second device's cached board, a retried
 * request) could otherwise send any enum value at all and move a ticket
 * backward, or resurrect one already served/cancelled.
 */
const LEGAL_TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  queued: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["served", "cancelled"],
  served: [],
  cancelled: [],
};

const TICKET_SUMMARY_COLUMNS =
  "id, ticket_number, status, prep_seconds, delay_seconds, is_delayed, target_minutes";

export async function advanceTicket(sb: Sb, userId: string, input: AdvanceTicketInput) {
  const { data: ticket } = await sb
    .from("restaurant_kitchen_tickets")
    .select(
      "id, ticket_number, order_id, station_id, location_id, status, target_minutes, queued_at, started_at, ready_at",
    )
    .eq("tenant_id", input.tenantId)
    .eq("id", input.ticketId)
    .single();
  if (!ticket) throw new Error("Ticket not found.");
  // Scoped by the ticket's own location — a kitchen.manage grant limited to
  // one property must not be able to advance another property's ticket.
  const { data: ticketStation } = ticket.station_id
    ? await sb
        .from("restaurant_stations")
        .select("station_type")
        .eq("tenant_id", input.tenantId)
        .eq("id", ticket.station_id)
        .maybeSingle()
    : { data: null };

  const isBarStation = (BAR_STATION_TYPES as readonly string[]).includes(
    String(ticketStation?.station_type ?? "").trim().toLowerCase(),
  );

  // Bar staff use the same ticket lifecycle endpoint, but their authority is
  // sales.manage rather than kitchen.manage. The ticket's own station type
  // determines which capability is required; scope still comes from the
  // ticket's location.
  await assertCapability(
    sb,
    userId,
    input.tenantId,
    isBarStation ? "sales.manage" : "kitchen.manage",
    { locationId: ticket.location_id },
  );

  if (input.status === ticket.status) {
    // Double click / client retry re-sending the status it already reached:
    // idempotent no-op, not an error and not a re-fired event.
    const { data: current } = await sb
      .from("restaurant_kitchen_tickets")
      .select(TICKET_SUMMARY_COLUMNS)
      .eq("tenant_id", input.tenantId)
      .eq("id", input.ticketId)
      .single();
    return current;
  }
  const legalNext = LEGAL_TICKET_TRANSITIONS[ticket.status] ?? [];
  if (!legalNext.includes(input.status)) {
    throw new Error(`A ticket cannot move from "${ticket.status}" to "${input.status}".`);
  }

  const now = new Date();
  const patch: Record<string, unknown> = { status: input.status };
  if (input.notes) patch.notes = input.notes;
  if (input.status === "preparing" && !ticket.started_at) patch.started_at = now.toISOString();

  let delaySeconds = 0;
  let prepSeconds: number | null = null;
  if (input.status === "ready") {
    patch.ready_at = now.toISOString();
    prepSeconds = Math.max(
      0,
      Math.round((now.getTime() - new Date(ticket.queued_at).getTime()) / 1000),
    );
    delaySeconds = Math.max(0, prepSeconds - ticket.target_minutes * 60);
    patch.prep_seconds = prepSeconds;
    patch.delay_seconds = delaySeconds;
    patch.is_delayed = delaySeconds > 0;
  }
  if (input.status === "served") patch.served_at = now.toISOString();

  // Compare-and-swap on the status this decision was made from: without it,
  // two concurrent calls that both read the same starting status (e.g. one
  // stale client still on "preparing" racing another that already moved to
  // "ready") can each pass the legality check above, and the second write
  // wins — silently discarding whichever transition lost the race and, in
  // that example, reverting an already-ready ticket back to preparing.
  const { data: updated, error } = await sb
    .from("restaurant_kitchen_tickets")
    .update(patch)
    .eq("tenant_id", input.tenantId)
    .eq("id", input.ticketId)
    .eq("status", ticket.status)
    .select(TICKET_SUMMARY_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!updated) {
    // Lost the race: some other call already moved this ticket since it was
    // read above. Re-fetch and decide rather than clobbering whatever it
    // landed on.
    const { data: latest } = await sb
      .from("restaurant_kitchen_tickets")
      .select(TICKET_SUMMARY_COLUMNS)
      .eq("tenant_id", input.tenantId)
      .eq("id", input.ticketId)
      .single();
    if (latest?.status === input.status) return latest; // another caller made the identical move
    throw new Error(
      `This ticket changed to "${latest?.status ?? "unknown"}" before this update reached it — refresh and try again.`,
    );
  }

  await sb
    .from("restaurant_kitchen_ticket_items")
    .update({ status: NEXT_ITEM_STATUS[input.status] ?? input.status })
    .eq("tenant_id", input.tenantId)
    .eq("ticket_id", input.ticketId);

  if (input.status === "ready") {
    await emitRestaurantEvent(sb, userId, {
      type:
        delaySeconds > 0 ? "restaurant.kitchen.ticket.delayed" : "restaurant.kitchen.ticket.ready",
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
      if (
        station &&
        (BAR_STATION_TYPES as readonly string[]).includes(String(station.station_type))
      ) {
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
  const scope = await getTenantScope(sb, userId, tenantId);
  const allowedLocationIds = await accessibleLocationIds(sb, scope);
  await assertCapability(sb, userId, tenantId, "kitchen.manage");
  if (allowedLocationIds !== null && allowedLocationIds.length === 0) return [];
  const from = since ?? new Date(Date.now() - 7 * 864e5).toISOString();
  let ticketsQuery = sb
    .from("restaurant_kitchen_tickets")
    .select("station_id, prep_seconds, delay_seconds, is_delayed, status")
    .eq("tenant_id", tenantId)
    .gte("queued_at", from);
  if (allowedLocationIds !== null) {
    ticketsQuery = ticketsQuery.in("location_id", allowedLocationIds);
  }

  let stationsQuery = sb
    .from("restaurant_stations")
    .select("id, name, target_prep_minutes, property_id, location_id")
    .eq("tenant_id", tenantId);
  if (allowedLocationIds !== null) {
    stationsQuery = stationsQuery.in("location_id", allowedLocationIds);
  }

  const [{ data: tickets }, { data: stations }] = await Promise.all([
    ticketsQuery,
    stationsQuery,
  ]);

  const byStation = new Map<string, { total: number; delayed: number; prep: number[] }>();
  for (const t of (tickets ?? []) as any[]) {
    if (t.prep_seconds == null) continue;
    const key = t.station_id ?? "unassigned";
    const agg = byStation.get(key) ?? { total: 0, delayed: 0, prep: [] };
    agg.total += 1;
    if (t.is_delayed) agg.delayed += 1;
    agg.prep.push(Number(t.prep_seconds));
    byStation.set(key, agg);
  }

  const visibleStations = ((stations ?? []) as any[]).filter((s) => {
    if (allowedLocationIds === null) return true;
    return Boolean(s.location_id && allowedLocationIds.includes(s.location_id));
  });

  return visibleStations.map((s) => {
    const agg = byStation.get(s.id) ?? { total: 0, delayed: 0, prep: [] };
    const avg = agg.prep.length > 0 ? agg.prep.reduce((a, b) => a + b, 0) / agg.prep.length : 0;
    return {
      station_id: s.id,
      name: s.name,
      target_minutes: Number(s.target_prep_minutes),
      tickets: agg.total,
      delayed: agg.delayed,
      on_time_percent:
        agg.total > 0 ? Number((((agg.total - agg.delayed) / agg.total) * 100).toFixed(1)) : null,
      avg_prep_minutes: Number((avg / 60).toFixed(1)),
    };
  });
}
