/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Guest dining-session projection — the read that replaces the old
 * "one storedOrderId, one order" guest portal model with the real shape of
 * a table's visit: one `restaurant_guest_sessions` row, zero or more
 * independent `restaurant_orders` (Order A, Order B, Order C, ...), each
 * keeping its own number/status/tickets/payment state untouched.
 *
 * This file creates no second session concept, no second order ledger, and
 * no second financial calculation engine:
 *  - Session membership is exactly `restaurant_orders.guest_session_id`
 *    (migration 0045), set once, server-side, by createGuestOrder at the
 *    moment resolveOrStartGuestSession already validated the session for
 *    that submission — never client-supplied, so a guest can never attach
 *    an arbitrary order to their session.
 *  - Every money figure is read straight off each order's own
 *    subtotal/discount_total/tax_total/service_charge/total/paid_total
 *    columns — the exact fields recalcOrder (sales.server.ts) already keeps
 *    authoritative on every write (order creation, firing, payment,
 *    cancellation). Session totals are a sum over those, nothing
 *    recomputed from raw lines a second time.
 *  - Per-order production status reuses the exact pure classifiers
 *    selftrack.server.ts already uses (classifyGuestStreams,
 *    classifyGuestOverallStage, deriveLifecycle) over the same
 *    restaurant_order_items/restaurant_kitchen_tickets rows — batched
 *    across every order in the session instead of one Supabase round trip
 *    per order, but identical logic, so a mixed order's "kitchen preparing,
 *    bar ready" reads exactly the same here as it does standalone.
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

export type GuestSessionOrderSummary = {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  paid: number;
  outstanding: number;
  overallStage: GuestOverallStage;
  streams: GuestProductionStream[];
};

export type GuestSessionProjection = {
  session: {
    startedAt: string;
    status: "active" | "expired" | "closed";
    table: { code: string; name: string };
  } | null;
  orders: GuestSessionOrderSummary[];
  totals: {
    subtotal: number;
    discounts: number;
    tax: number;
    serviceCharge: number;
    total: number;
    paid: number;
    outstanding: number;
    currency: string;
  };
};

function emptyTotals(currency: string): GuestSessionProjection["totals"] {
  return {
    subtotal: 0,
    discounts: 0,
    tax: 0,
    serviceCharge: 0,
    total: 0,
    paid: 0,
    outstanding: 0,
    currency,
  };
}

/**
 * The currently active, unexpired dining session for this table, if any.
 * Read-only on purpose — resolveOrStartGuestSession is the sole writer that
 * lazily expires a stale row; a plain status read here never mutates
 * anything, it just also treats a session whose expiry has passed as "no
 * active session" without waiting for the next order attempt to notice.
 */
async function loadActiveSession(sb: Sb, tenantId: string, tableId: string) {
  const { data } = await sb
    .from("restaurant_guest_sessions")
    .select("id, status, started_at, expires_at")
    .eq("tenant_id", tenantId)
    .eq("table_id", tableId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at) <= new Date()) return null;
  return data as { id: string; status: string; started_at: string; expires_at: string };
}

/** Station-id -> station-type lookup shared across every order's stream classification. */
function buildStationTypeLookup(stations: { id: string; station_type: string | null }[]) {
  const byId = new Map(stations.map((s) => [s.id, s.station_type ?? null]));
  return (stationId: string | null) => (stationId ? (byId.get(stationId) ?? null) : null);
}

/**
 * The full session projection for a table: the active session (if any) plus
 * every order it has produced so far, each with its own redacted production
 * progress, plus server-derived session-wide totals. Table-scoped through
 * the same resolveGuestTableContext boundary as every other guest function —
 * nothing about tenant/property/location/order/payment state is ever
 * accepted from the client.
 */
export async function guestSessionProjection(
  sb: Sb,
  input: { tableId: string },
): Promise<GuestSessionProjection> {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const session = await loadActiveSession(sb, table.tenantId, table.tableId);

  if (!session) {
    return { session: null, orders: [], totals: emptyTotals(table.currency) };
  }

  const { data: orderRows } = await sb
    .from("restaurant_orders")
    .select(
      "id, order_number, status, subtotal, discount_total, tax_total, service_charge, total, paid_total, currency, opened_at",
    )
    .eq("tenant_id", table.tenantId)
    .eq("guest_session_id", session.id)
    .order("opened_at");
  const orders = (orderRows ?? []) as any[];

  if (orders.length === 0) {
    return {
      session: {
        startedAt: session.started_at,
        status: session.status as "active",
        table: { code: table.tableCode, name: table.tableName },
      },
      orders: [],
      totals: emptyTotals(table.currency),
    };
  }

  const orderIds = orders.map((o) => o.id);
  const [{ data: itemRows }, { data: ticketRows }] = await Promise.all([
    sb
      .from("restaurant_order_items")
      .select("order_id, status, station_id")
      .eq("tenant_id", table.tenantId)
      .in("order_id", orderIds),
    sb
      .from("restaurant_kitchen_tickets")
      .select("order_id, status, station_id")
      .eq("tenant_id", table.tenantId)
      .in("order_id", orderIds),
  ]);
  const items = (itemRows ?? []) as {
    order_id: string;
    status: string;
    station_id: string | null;
  }[];
  const tickets = (ticketRows ?? []) as {
    order_id: string;
    status: string;
    station_id: string | null;
  }[];

  const stationIds = [
    ...new Set(
      [...items.map((i) => i.station_id), ...tickets.map((t) => t.station_id)].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  let stations: { id: string; station_type: string | null }[] = [];
  if (stationIds.length > 0) {
    const { data } = await sb
      .from("restaurant_stations")
      .select("id, station_type")
      .eq("tenant_id", table.tenantId)
      .in("id", stationIds);
    stations = (data ?? []) as any[];
  }
  const stationTypeOf = buildStationTypeLookup(stations);

  const orderSummaries: GuestSessionOrderSummary[] = orders.map((order) => {
    const total = Number(order.total ?? 0);
    const paid = Number(order.paid_total ?? 0);
    const outstanding = Math.max(0, total - paid);

    if (order.status === "cancelled" || order.status === "voided") {
      return {
        id: order.id,
        orderNumber: order.order_number,
        status: order.status,
        total,
        paid,
        outstanding,
        overallStage: "cancelled",
        streams: [],
      };
    }

    const orderItems = items.filter((i) => i.order_id === order.id);
    const orderTickets = tickets.filter((t) => t.order_id === order.id);
    const streams = classifyGuestStreams(
      orderItems.map((i) => ({ status: i.status, stationType: stationTypeOf(i.station_id) })),
      orderTickets.map((t) => ({ status: t.status, stationType: stationTypeOf(t.station_id) })),
    );
    const life = deriveLifecycle({
      order: { status: order.status },
      items: orderItems,
      tickets: orderTickets,
    });
    const overallStage = classifyGuestOverallStage(order.status, life);

    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      total,
      paid,
      outstanding,
      overallStage,
      streams,
    };
  });

  const totals = orders.reduce(
    (acc, order) => {
      acc.subtotal += Number(order.subtotal ?? 0);
      acc.discounts += Number(order.discount_total ?? 0);
      acc.tax += Number(order.tax_total ?? 0);
      acc.serviceCharge += Number(order.service_charge ?? 0);
      acc.total += Number(order.total ?? 0);
      acc.paid += Number(order.paid_total ?? 0);
      return acc;
    },
    { subtotal: 0, discounts: 0, tax: 0, serviceCharge: 0, total: 0, paid: 0 },
  );

  return {
    session: {
      startedAt: session.started_at,
      status: session.status as "active",
      table: { code: table.tableCode, name: table.tableName },
    },
    orders: orderSummaries,
    totals: {
      subtotal: Number(totals.subtotal.toFixed(2)),
      discounts: Number(totals.discounts.toFixed(2)),
      tax: Number(totals.tax.toFixed(2)),
      serviceCharge: Number(totals.serviceCharge.toFixed(2)),
      total: Number(totals.total.toFixed(2)),
      paid: Number(totals.paid.toFixed(2)),
      outstanding: Number(Math.max(0, totals.total - totals.paid).toFixed(2)),
      currency: orders[0]?.currency ?? table.currency,
    },
  };
}
