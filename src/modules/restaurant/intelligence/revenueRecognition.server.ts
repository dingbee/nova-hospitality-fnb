/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * ME-06: restaurant_orders.payment_state can never actually become
 * 'refunded' in practice — recalcOrder (the sole writer of that column,
 * sales/sales.server.ts) only ever assigns 'unpaid' | 'partially_paid' |
 * 'paid'; the enum also carries 'comped' | 'room_charged' | 'refunded',
 * but 'refunded' is set nowhere in the application. Several intelligence
 * reports (revenue, forecasting, multi-location) filtered on
 * `.neq("payment_state", "refunded")`, intending to exclude fully-refunded
 * closed orders from revenue totals — a filter that could never fire,
 * so a fully-refunded order's full original total kept counting as
 * realized revenue indefinitely (mandate section 18: "refunds counted as
 * sales").
 *
 * A closed order only reaches payment_state 'unpaid' again after having
 * been paid and then fully refunded (takePosPayment only closes an order
 * once its payment_state is paid/comped/room_charged — see
 * sales/pos.server.ts), so among closed orders sitting at a near-zero
 * paid_total, the ones that actually had a refund recorded against them
 * are the ones this filter was meant to exclude.
 */
type Sb = any;

export async function fetchFullyRefundedOrderIds(
  sb: Sb,
  tenantId: string,
  orders: Array<{ id: string; paid_total?: number | string | null }>,
): Promise<Set<string>> {
  const zeroBalanceIds = orders.filter((o) => Number(o.paid_total ?? 0) <= 0.009).map((o) => o.id);
  if (zeroBalanceIds.length === 0) return new Set();

  const { data } = await sb
    .from("restaurant_payments")
    .select("order_id")
    .eq("tenant_id", tenantId)
    .in("order_id", zeroBalanceIds)
    .eq("state", "refunded")
    .not("refund_of", "is", null);

  return new Set(((data ?? []) as Array<{ order_id: string }>).map((r) => r.order_id));
}
