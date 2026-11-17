/**
 * Negative-stock policy — one rule for every stock-affecting path.
 *
 * Before UAT-1 only manual wastage honoured `allow_negative`; sales
 * consumption, modifiers, transfers and production could drive a balance below
 * zero silently. The policy below is pure so it can be asserted in tests and
 * reused identically by the ledger writer and the database trigger.
 *
 * Corrections are never refused: a reversal, an adjustment or an inbound
 * movement exists precisely to repair a wrong balance.
 */
import type { StockMovementType } from "../core/contracts";

/** Movement types that reduce a balance. */
export const OUTBOUND_TYPES: readonly StockMovementType[] = [
  "consumption",
  "wastage",
  "transfer_out",
  "adjustment_out",
  "return_to_supplier",
];

/** Movement types that exist to repair state and therefore bypass the policy. */
export const CORRECTION_TYPES: readonly StockMovementType[] = ["reversal", "adjustment"];

export type NegativeStockDecision =
  | { allowed: true; reason: "inbound" | "correction" | "sufficient" | "tenant_allows" | "approved" }
  | { allowed: false; code: "negative_stock"; message: string; shortfall: number };

export function evaluateNegativeStock(args: {
  movementType: StockMovementType;
  /** Signed quantity exactly as it will be written to the ledger. */
  quantity: number;
  currentQuantity: number;
  allowNegative: boolean;
  /** A supervisor override recorded on the movement. */
  approvedBy?: string | null;
  itemName?: string;
}): NegativeStockDecision {
  if (CORRECTION_TYPES.includes(args.movementType)) return { allowed: true, reason: "correction" };
  if (args.quantity >= 0) return { allowed: true, reason: "inbound" };

  const resulting = Number((args.currentQuantity + args.quantity).toFixed(6));
  if (resulting >= 0) return { allowed: true, reason: "sufficient" };
  if (args.allowNegative) return { allowed: true, reason: "tenant_allows" };
  if (args.approvedBy) return { allowed: true, reason: "approved" };

  return {
    allowed: false,
    code: "negative_stock",
    shortfall: Number(Math.abs(resulting).toFixed(6)),
    message: `${args.itemName ?? "This stock item"} would go to ${resulting} (short by ${Math.abs(resulting)}). Negative stock is not permitted for this item — receive stock, correct the count, or enable negative stock for it.`,
  };
}

/** Human label for the ledger `reason_code` column. */
export const REASON_CODES = {
  saleReversal: "sale_reversal",
  orderCancellation: "order_cancellation",
  refundReversal: "refund_reversal",
} as const;
