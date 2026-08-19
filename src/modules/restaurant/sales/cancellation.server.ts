/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Governed whole-order cancellation.
 *
 * Reuses the existing pieces end to end: the state machine decides, the
 * inventory ledger performs the correction, the sales core recomputes the
 * money and the existing event seam records it. It writes nothing directly to
 * a balance and it creates no second transaction engine.
 */
import { assertCapability } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { REASON_CODES } from "../inventory/policy";
import { reverseMovementsForOrder } from "../inventory/reversal.server";
import { recalcOrder } from "./sales.server";
import { evaluateCancellation } from "./cancellation";
import type { CancelOrderInput } from "./pos.contracts";

type Sb = any;

export async function cancelOrder(sb: Sb, userId: string, input: CancelOrderInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.void");

  const { data: order } = await sb
    .from("restaurant_orders")
    .select(
      "id, order_number, status, payment_state, table_id, location_id, property_id, total, paid_total, currency, cancelled_at",
    )
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .single();
  if (!order) throw new Error("Order not found.");

  const [{ data: payments }, { data: items }, { data: movements }] = await Promise.all([
    sb.from("restaurant_payments").select("amount, state").eq("tenant_id", input.tenantId).eq("order_id", input.orderId),
    sb
      .from("restaurant_order_items")
      .select("id, status")
      .eq("tenant_id", input.tenantId)
      .eq("order_id", input.orderId),
    sb
      .from("restaurant_stock_movements")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .eq("reference_type", "restaurant_order")
      .eq("reference_id", input.orderId)
      .in("movement_type", ["consumption", "production"]),
  ]);

  const outstandingPaid = ((payments ?? []) as any[]).reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const lines = (items ?? []) as any[];

  const decision = evaluateCancellation({
    status: String(order.status),
    paymentState: String(order.payment_state),
    outstandingPaid,
    preparedLines: lines.filter((l) => ["sent", "preparing", "ready", "served"].includes(String(l.status))).length,
    consumedMovements: ((movements ?? []) as any[]).length,
  });

  if (decision.outcome === "noop") {
    return { cancelled: true, idempotent: true, reversal: null, order, message: decision.message };
  }
  if (decision.outcome === "refuse") {
    throw new Error(decision.message);
  }

  // Ledger correction first — if stock cannot be unwound, nothing is cancelled.
  const reversal = decision.reverseStock
    ? await reverseMovementsForOrder(sb, userId, {
        tenantId: input.tenantId,
        orderId: input.orderId,
        reason: `Order cancelled: ${input.reason}`,
        reasonCode: REASON_CODES.orderCancellation,
      })
    : null;

  const now = new Date().toISOString();
  const liveLineIds = lines.filter((l) => l.status !== "voided").map((l) => l.id);
  if (liveLineIds.length > 0) {
    await sb
      .from("restaurant_order_items")
      .update({ status: "voided", void_reason: `Order cancelled: ${input.reason}`, voided_by: userId, voided_at: now })
      .eq("tenant_id", input.tenantId)
      .in("id", liveLineIds);
  }

  const { error } = await sb
    .from("restaurant_orders")
    .update({
      status: "cancelled",
      cancelled_at: now,
      cancelled_by: userId,
      cancel_reason: input.reason,
      cost_total: 0,
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId);
  if (error) throw new Error(error.message);

  if (order.table_id) {
    await sb.from("restaurant_tables").update({ status: "available" }).eq("id", order.table_id).eq("tenant_id", input.tenantId);
  }

  const totals = await recalcOrder(sb, input.tenantId, input.orderId);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.order.cancelled",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: order.id,
    source: "restaurant-pos",
    payload: {
      order_number: order.order_number,
      reason: input.reason,
      previous_status: order.status,
      lines_voided: liveLineIds.length,
      stock_movements_reversed: reversal?.reversed ?? 0,
      cost_restored: reversal?.costRestored ?? 0,
      wastage_likely: decision.wastageLikely,
    },
    dedupeKey: `order-cancelled:${order.id}`,
  });

  return { cancelled: true, idempotent: false, reversal, order: totals, message: decision.message };
}
