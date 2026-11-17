/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Canonical ledger reversal.
 *
 * A sale that moved stock and is later voided, cancelled or refunded must move
 * that stock back — through the ledger, never by editing a balance. A reversal
 * is a mirror movement: same tenant, outlet, item, unit, batch and unit cost,
 * opposite sign, pointing at the movement it corrects via `reversal_of_id` and
 * sharing its correlation id. It is idempotent by `reverse:<movement id>`, so a
 * double-tapped void, a retried request and a replayed webhook all produce
 * exactly one correction.
 *
 * This reverses whatever the sale actually generated — direct ingredients,
 * exploded sub-recipes, stock-affecting modifiers, batch allocations — because
 * it works from the recorded movements rather than re-deriving the recipe.
 */
import { insertMovement } from "./movements.server";
import { REASON_CODES } from "./policy";

type Sb = any;

const REVERSIBLE = ["consumption", "production", "wastage", "purchase_receipt", "transfer_out", "transfer_in"];

export interface ReversalResult {
  /** Movements newly written by this call. */
  reversed: number;
  /** Movements that were already reversed by an earlier attempt. */
  alreadyReversed: number;
  /** Signed cost restored to the operation (positive = cost taken back off the order). */
  costRestored: number;
  movementIds: string[];
}

const EMPTY: ReversalResult = { reversed: 0, alreadyReversed: 0, costRestored: 0, movementIds: [] };

/**
 * Reverses every stock-affecting movement produced by one sold line.
 * Reversals themselves are excluded, so reversing twice is a no-op.
 */
export async function reverseMovementsForOrderItem(
  sb: Sb,
  userId: string,
  args: {
    tenantId: string;
    orderItemId: string;
    reason: string;
    reasonCode?: string;
    occurredAt?: string;
  },
): Promise<ReversalResult> {
  const { data } = await sb
    .from("restaurant_stock_movements")
    .select(
      "id, tenant_id, property_id, location_id, destination_location_id, inventory_item_id, unit_id, movement_type, quantity, unit_cost, currency, batch_id, correlation_id, reference_type, reference_id, order_item_id",
    )
    .eq("tenant_id", args.tenantId)
    .eq("order_item_id", args.orderItemId)
    .in("movement_type", REVERSIBLE);

  return applyReversals(sb, userId, (data ?? []) as any[], {
    reason: args.reason,
    reasonCode: args.reasonCode ?? REASON_CODES.saleReversal,
    occurredAt: args.occurredAt,
  });
}

/** Reverses every movement written against one order (all of its sold lines). */
export async function reverseMovementsForOrder(
  sb: Sb,
  userId: string,
  args: { tenantId: string; orderId: string; reason: string; reasonCode?: string; occurredAt?: string },
): Promise<ReversalResult> {
  const { data } = await sb
    .from("restaurant_stock_movements")
    .select(
      "id, tenant_id, property_id, location_id, destination_location_id, inventory_item_id, unit_id, movement_type, quantity, unit_cost, currency, batch_id, correlation_id, reference_type, reference_id, order_item_id",
    )
    .eq("tenant_id", args.tenantId)
    .eq("reference_type", "restaurant_order")
    .eq("reference_id", args.orderId)
    .in("movement_type", REVERSIBLE);

  return applyReversals(sb, userId, (data ?? []) as any[], {
    reason: args.reason,
    reasonCode: args.reasonCode ?? REASON_CODES.orderCancellation,
    occurredAt: args.occurredAt,
  });
}

async function applyReversals(
  sb: Sb,
  userId: string,
  originals: any[],
  ctx: { reason: string; reasonCode: string; occurredAt?: string },
): Promise<ReversalResult> {
  if (originals.length === 0) return { ...EMPTY };

  const at = ctx.occurredAt ?? new Date().toISOString();
  const result: ReversalResult = { reversed: 0, alreadyReversed: 0, costRestored: 0, movementIds: [] };

  for (const original of originals) {
    const quantity = -Number(original.quantity ?? 0);
    if (quantity === 0) continue;

    const written = await insertMovement(sb, userId, {
      tenantId: original.tenant_id,
      propertyId: original.property_id,
      locationId: original.location_id,
      destinationLocationId: original.destination_location_id,
      inventoryItemId: original.inventory_item_id,
      unitId: original.unit_id,
      movementType: "reversal",
      quantity,
      // Cost integrity: a reversal is valued at the cost the original movement
      // carried, never at today's average, so quantity and value unwind together.
      unitCost: Number(original.unit_cost ?? 0),
      currency: original.currency ?? "TZS",
      reason: ctx.reason,
      reasonCode: ctx.reasonCode,
      referenceType: original.reference_type,
      referenceId: original.reference_id,
      orderItemId: original.order_item_id,
      batchId: original.batch_id,
      reversalOfId: original.id,
      correlationId: original.correlation_id ?? original.id,
      occurredAt: at,
      dedupeKey: `reverse:${original.id}`,
    });

    if (!written) {
      result.alreadyReversed += 1;
      continue;
    }
    result.reversed += 1;
    result.movementIds.push(written.id);
    // Consumption was negative, so its reversal is positive: the cost it
    // restores is the cost the sale had booked.
    result.costRestored += Math.abs(Number(original.quantity ?? 0)) * Number(original.unit_cost ?? 0);
  }

  result.costRestored = Number(result.costRestored.toFixed(4));
  return result;
}
