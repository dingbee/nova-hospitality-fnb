/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Guest order-progress — the read-only counterpart to selfbill.server.ts's
 * write. Table+order scoped through the same resolveGuestTableContext
 * boundary as every other guest function in this module; nothing about
 * tenant/property/location/ticket status/station/payment state is ever
 * accepted from the client — this file only reads restaurant_order_items,
 * restaurant_kitchen_tickets and restaurant_stations, the exact tables
 * kitchen.server.ts's listTickets and lifecycle.ts's deriveLifecycle already
 * read, and hands the result to ../selforder-tracking.ts (pure, DB-free) to
 * turn into a station-aware, redacted projection. No internal id, note,
 * cost, delay figure, or raw error ever reaches the return value.
 */
import { resolveGuestTableContext } from "./selforder.server";
import { deriveLifecycle } from "../sales/ui/lifecycle";
import {
  classifyGuestOverallStage,
  classifyGuestStreams,
  type GuestOverallStage,
  type GuestProductionStream,
} from "./selforder-tracking";

type Sb = any;

/** Table + order scoped exactly like loadGuestOrder in selfpay.server.ts / selfbill.server.ts. */
async function loadGuestOrderForTracking(
  sb: Sb,
  tenantId: string,
  tableId: string,
  orderId: string,
) {
  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .eq("table_id", tableId)
    .maybeSingle();
  if (!order) throw new Error("Order not found for this table.");
  return order;
}

export type GuestOrderProgress = {
  orderNumber: string;
  overallStage: GuestOverallStage;
  streams: GuestProductionStream[];
};

export async function guestOrderProgress(
  sb: Sb,
  input: { tableId: string; orderId: string },
): Promise<GuestOrderProgress> {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrderForTracking(sb, table.tenantId, input.tableId, input.orderId);

  // A cancelled/voided order's tickets reflect whatever state they were in
  // at cancellation, not this order's current story — show the cancellation
  // itself and nothing stale from before it.
  if (order.status === "cancelled" || order.status === "voided") {
    return { orderNumber: order.order_number, overallStage: "cancelled", streams: [] };
  }

  const { data: itemRows } = await sb
    .from("restaurant_order_items")
    .select("status, station_id")
    .eq("tenant_id", table.tenantId)
    .eq("order_id", order.id);
  const { data: ticketRows } = await sb
    .from("restaurant_kitchen_tickets")
    .select("status, station_id")
    .eq("tenant_id", table.tenantId)
    .eq("order_id", order.id);

  const items = (itemRows ?? []) as { status: string; station_id: string | null }[];
  const tickets = (ticketRows ?? []) as { status: string; station_id: string | null }[];

  const stationIds = [
    ...new Set(
      [...items.map((i) => i.station_id), ...tickets.map((t) => t.station_id)].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  const stationTypeById = new Map<string, string | null>();
  if (stationIds.length > 0) {
    const { data: stations } = await sb
      .from("restaurant_stations")
      .select("id, station_type")
      .eq("tenant_id", table.tenantId)
      .in("id", stationIds);
    for (const s of (stations ?? []) as any[]) stationTypeById.set(s.id, s.station_type ?? null);
  }
  const stationTypeOf = (stationId: string | null) =>
    stationId ? (stationTypeById.get(stationId) ?? null) : null;

  const streams = classifyGuestStreams(
    items.map((i) => ({ status: i.status, stationType: stationTypeOf(i.station_id) })),
    tickets.map((t) => ({ status: t.status, stationType: stationTypeOf(t.station_id) })),
  );

  const life = deriveLifecycle({ order: { status: order.status }, items, tickets });
  const overallStage = classifyGuestOverallStage(order.status, life);

  return { orderNumber: order.order_number, overallStage, streams };
}
