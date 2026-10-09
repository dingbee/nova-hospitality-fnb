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
import { cancelKitchenTicketItemsForOrderItems } from "../kitchen/kitchen.server";
import { REASON_CODES } from "../inventory/policy";
import { reverseMovementsForOrderItem } from "../inventory/reversal.server";
import { closeActiveGuestSession } from "../selforder/selforder.server";
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
    sb
      .from("restaurant_payments")
      .select("amount, state")
      .eq("tenant_id", input.tenantId)
      .eq("order_id", input.orderId),
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

  const outstandingPaid = ((payments ?? []) as any[]).reduce(
    (s, p) => s + Number(p.amount ?? 0),
    0,
  );
  const lines = (items ?? []) as any[];

  const decision = evaluateCancellation({
    status: String(order.status),
    paymentState: String(order.payment_state),
    outstandingPaid,
    preparedLines: lines.filter((l) =>
      ["fired", "sent", "preparing", "ready", "served"].includes(String(l.status)),
    ).length,
    consumedMovements: ((movements ?? []) as any[]).length,
  });

  if (decision.outcome === "noop") {
    return { cancelled: true, idempotent: true, reversal: null, order, message: decision.message };
  }
  if (decision.outcome === "refuse") {
    throw new Error(decision.message);
  }

  // Correct stock per line, not per order. Only lines that never reached
  // production/service can safely return their recorded consumption to stock.
  // Prepared/served lines retain their stock deduction because those goods are
  // no longer reusable; their cost remains visible in the inventory ledger.
  const preparedStatuses = ["fired", "sent", "preparing", "ready", "served"];
  const stockLines = lines.filter((line) => line.status !== "voided");
  const reversal = decision.reverseStock
    ? await (async () => {
        const combined = { reversed: 0, alreadyReversed: 0, costRestored: 0, movementIds: [] as string[] };
        for (const line of stockLines) {
          if (preparedStatuses.includes(String(line.status))) continue;
          const part = await reverseMovementsForOrderItem(sb, userId, {
            tenantId: input.tenantId,
            orderItemId: line.id,
            reason: `Order cancelled: ${input.reason}`,
            reasonCode: REASON_CODES.orderCancellation,
          });
          combined.reversed += part.reversed;
          combined.alreadyReversed += part.alreadyReversed;
          combined.costRestored += part.costRestored;
          combined.movementIds.push(...part.movementIds);
        }
        combined.costRestored = Number(combined.costRestored.toFixed(4));
        return combined;
      })()
    : null;
  const preparedLinesPreserved = stockLines.filter((line) => preparedStatuses.includes(String(line.status))).length;

  const now = new Date().toISOString();
  const liveLineIds = lines.filter((l) => l.status !== "voided").map((l) => l.id);
  if (liveLineIds.length > 0) {
    await sb
      .from("restaurant_order_items")
      .update({
        status: "voided",
        void_reason: `Order cancelled: ${input.reason}`,
        voided_by: userId,
        voided_at: now,
      })
      .eq("tenant_id", input.tenantId)
      .in("id", liveLineIds);
    // Same gap as voidPosLine: a whole-order cancellation must not leave any
    // already-fired line's kitchen/bar ticket item behind as phantom
    // production. See cancelKitchenTicketItemsForOrderItems's doc comment.
    await cancelKitchenTicketItemsForOrderItems(sb, input.tenantId, liveLineIds);
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
    await sb
      .from("restaurant_tables")
      .update({ status: "available" })
      .eq("id", order.table_id)
      .eq("tenant_id", input.tenantId);
    // O12: cancellation hands the table back exactly like a settled bill
    // does — the dining session that placed this order is over.
    await closeActiveGuestSession(sb, order.table_id, "order_cancelled");
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
      prepared_lines_stock_preserved: preparedLinesPreserved,
      wastage_follow_up_required: preparedLinesPreserved > 0,
    },
    dedupeKey: `order-cancelled:${order.id}`,
  });

  return { cancelled: true, idempotent: false, reversal, order: totals, message: decision.message };
}
