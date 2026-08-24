/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Guest-facing "request bill" — the smallest safe wrapper around the
 * canonical staff bill lifecycle (bill_requested_at / bill_presented_at,
 * the staff request/present-bill actions, deriveLifecycle() in
 * ../sales/bill.server.ts), reachable without a staff principal.
 *
 * The staff-only bill.server.ts is completely untouched by this file —
 * its own request-bill action still requires the same capability check
 * and a real userId it always has, and nothing here imports or calls it.
 * This performs the identical, minimal state transition (setting
 * bill_requested_at, once) through the same guest-authorization boundary
 * every other file in this module already uses —
 * resolveGuestTableContext, table-scoped, with nothing about
 * tenant/property/location/order-status/timestamps ever accepted from
 * the client.
 */
import { resolveGuestTableContext } from "./selforder.server";

type Sb = any;

/**
 * The exact set the canonical staff lifecycle already treats as "still
 * active" — restaurant_order_status has exactly six values (open, sent,
 * served, closed, cancelled, voided); the other three are terminal.
 * Duplicated from selfpay.server.ts's PAYABLE_ORDER_STATUSES rather than
 * imported (that file is a distinct payment-adjacent module, kept
 * untouched by this change) and because the staff request-bill action
 * itself carries no status gate of its own to reuse — this is the same
 * boundary
 * initiateGuestPayment and Phase 3's order-recovery classifier already
 * use for "is this order still something a guest can act on", not a new
 * invented rule.
 */
const BILL_REQUESTABLE_ORDER_STATUSES = new Set(["open", "sent", "served"]);

/** Table + order scoped exactly like selfpay.server.ts's loadGuestOrder — a provider reference or client-supplied order id proves nothing on its own; this is the one query that decides whether it belongs to this table at all. */
async function loadGuestOrderForBill(sb: Sb, tenantId: string, tableId: string, orderId: string) {
  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, bill_requested_at, bill_presented_at, total, currency")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .eq("table_id", tableId)
    .maybeSingle();
  if (!order) throw new Error("Order not found for this table.");
  return order;
}

export type RequestGuestBillResult =
  | { ok: true; billRequestedAt: string; billPresentedAt: string | null }
  | { ok: false; reason: "not_requestable"; orderStatus: string };

/**
 * Idempotent by construction: a second call for an order that already has
 * bill_requested_at set returns that same timestamp rather than writing
 * again — the guest tapping "Request bill" twice (a slow network, a
 * double tap, a page reload) never produces a second request. Once the
 * bill has been presented (bill_presented_at set by staff through the
 * existing presentBill()), that fact is preserved too — this function
 * only ever writes bill_requested_at, never bill_presented_at, so it
 * cannot regress a bill staff have already brought to the table.
 */
export async function requestGuestBill(
  sb: Sb,
  input: { tableId: string; orderId: string },
): Promise<RequestGuestBillResult> {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrderForBill(sb, table.tenantId, input.tableId, input.orderId);

  if (order.bill_requested_at) {
    return {
      ok: true,
      billRequestedAt: order.bill_requested_at,
      billPresentedAt: order.bill_presented_at,
    };
  }
  if (!BILL_REQUESTABLE_ORDER_STATUSES.has(order.status)) {
    return { ok: false, reason: "not_requestable", orderStatus: order.status };
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await sb
    .from("restaurant_orders")
    // bill_requested_by stays null — there is no staff user behind a guest
    // request, the same way createGuestOrder (sales.server.ts) sets
    // created_by: null. The column is nullable; nothing here invents a
    // "guest" pseudo-identity to fill it.
    .update({ bill_requested_at: now, bill_requested_by: null })
    .eq("tenant_id", table.tenantId)
    .eq("id", order.id)
    .select("bill_requested_at, bill_presented_at")
    .single();
  if (error) throw new Error(error.message);

  // Not routed through emitRestaurantEvent/recordEvent: that path calls
  // assertIntelRead(supabase, userId), which requires a real staff
  // principal, and there is none here — the exact same, already-made
  // decision documented on createGuestOrder in sales.server.ts. A guest
  // request's own audit trail is bill_requested_at itself (plus the
  // order's source = 'self_order'); wiring guest-originated actions into
  // the Intelligence Core event stream is a separate, later decision this
  // change does not make.
  return {
    ok: true,
    billRequestedAt: updated.bill_requested_at,
    billPresentedAt: updated.bill_presented_at,
  };
}
