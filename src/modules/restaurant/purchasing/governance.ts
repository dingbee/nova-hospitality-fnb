/**
 * Purchase-order commercial governance — pure and browser-safe.
 *
 * One definition of what makes an order line and an order's totals valid.
 * The server computes every amount with these functions (never trusting a
 * client-supplied total), the database guard (migration 0157) enforces the
 * same rules at submission and approval, and the UI uses them only to
 * explain a refusal before the round trip.
 */

export class PurchaseOrderGovernanceError extends Error {
  constructor(
    readonly code:
      | "PO_LINE_INVALID"
      | "PO_PRICE_REQUIRED"
      | "PO_PRICE_EXCEPTION_REASON_REQUIRED"
      | "PO_CURRENCY_INVALID"
      | "PO_NO_LINES"
      | "PO_TOTALS_UNRECONCILED"
      | "PO_SUPPLIER_REQUIRED"
      | "PO_SUPPLIER_INACTIVE"
      | "PO_DESTINATION_UNRESOLVED",
    message: string,
  ) {
    super(`${code} — ${message}`);
    this.name = "PurchaseOrderGovernanceError";
  }
}

/** Money precision used by the order header and line totals (numeric(14,2)). */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export const PRICE_EXCEPTION_MIN_REASON = 10;

export interface PurchaseOrderLineDraft {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Only for an explicitly authorised zero-price line (sample, complimentary). */
  priceExceptionReason?: string | null;
}

export interface PricedPurchaseOrderLine extends PurchaseOrderLineDraft {
  lineTotal: number;
  priceExceptionReason: string | null;
}

export function assertCurrency(currency: string): string {
  const c = String(currency ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) {
    throw new PurchaseOrderGovernanceError(
      "PO_CURRENCY_INVALID",
      `"${currency}" is not an ISO 4217 currency code.`,
    );
  }
  return c;
}

/**
 * Validates and prices order lines. A zero unit price is refused unless the
 * line carries an explicit exception reason; negative, missing or
 * non-finite numbers are always refused.
 */
export function priceOrderLines(lines: readonly PurchaseOrderLineDraft[]): {
  lines: PricedPurchaseOrderLine[];
  subtotal: number;
} {
  const priced = lines.map((line) => {
    const label = line.description?.trim() || "Line";
    const quantity = Number(line.quantity);
    const unitPrice = Number(line.unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PurchaseOrderGovernanceError(
        "PO_LINE_INVALID",
        `"${label}": quantity must be greater than zero.`,
      );
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new PurchaseOrderGovernanceError(
        "PO_PRICE_REQUIRED",
        `"${label}": a valid unit price is required.`,
      );
    }
    const reason = line.priceExceptionReason?.trim() || null;
    if (unitPrice === 0) {
      if (!reason) {
        throw new PurchaseOrderGovernanceError(
          "PO_PRICE_REQUIRED",
          `"${label}": unit price is zero. Enter the agreed price, or record an authorised zero-price exception with a reason.`,
        );
      }
      if (reason.length < PRICE_EXCEPTION_MIN_REASON) {
        throw new PurchaseOrderGovernanceError(
          "PO_PRICE_EXCEPTION_REASON_REQUIRED",
          `"${label}": a zero-price exception needs a reason of at least ${PRICE_EXCEPTION_MIN_REASON} characters.`,
        );
      }
    }
    return {
      ...line,
      quantity,
      unitPrice,
      // A reason on a priced line is meaningless; never persist it as an exception.
      priceExceptionReason: unitPrice === 0 ? reason : null,
      lineTotal: roundMoney(quantity * unitPrice),
    };
  });
  const subtotal = roundMoney(priced.reduce((sum, l) => sum + l.lineTotal, 0));
  return { lines: priced, subtotal };
}

export interface PurchaseOrderCommitmentSnapshot {
  supplierId: string | null;
  supplierStatus: string | null;
  propertyId: string | null;
  locationId: string | null;
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  total: number;
  lines: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    priceExceptionReason: string | null;
    priceExceptionAuthorisedBy: string | null;
  }>;
}

/**
 * Re-validates an order against current supplier, destination and pricing
 * rules before it is submitted or approved. Returns every issue so the
 * caller can report them together; an empty list means the order may move.
 */
export function purchaseOrderCommitmentIssues(o: PurchaseOrderCommitmentSnapshot): string[] {
  const issues: string[] = [];
  if (!o.locationId && !o.propertyId) {
    issues.push("PO_DESTINATION_UNRESOLVED — the order has no destination location or property.");
  }
  if (!o.supplierId) {
    issues.push("PO_SUPPLIER_REQUIRED — the order has no supplier.");
  } else if (o.supplierStatus !== "active") {
    issues.push(
      `PO_SUPPLIER_INACTIVE — the supplier is ${o.supplierStatus ?? "unknown"}; only an active supplier can receive a submitted or approved order.`,
    );
  }
  if (o.lines.length === 0) issues.push("PO_NO_LINES — the order has no lines.");
  let lineSum = 0;
  for (const l of o.lines) {
    lineSum += Number(l.lineTotal);
    const label = l.description || "Line";
    if (!(Number(l.quantity) > 0)) issues.push(`PO_LINE_INVALID — "${label}": quantity must be > 0.`);
    if (!(Number(l.unitPrice) >= 0)) {
      issues.push(`PO_PRICE_REQUIRED — "${label}": unit price is invalid.`);
    } else if (Number(l.unitPrice) === 0) {
      const reason = l.priceExceptionReason?.trim() ?? "";
      if (reason.length < PRICE_EXCEPTION_MIN_REASON || !l.priceExceptionAuthorisedBy) {
        issues.push(
          `PO_PRICE_REQUIRED — "${label}": zero unit price without an authorised price exception.`,
        );
      }
    }
    if (Math.abs(Number(l.lineTotal) - roundMoney(Number(l.quantity) * Number(l.unitPrice))) > 0.01) {
      issues.push(`PO_TOTALS_UNRECONCILED — "${label}": line total does not equal quantity × price.`);
    }
  }
  if (Math.abs(Number(o.subtotal) - roundMoney(lineSum)) > 0.01) {
    issues.push(
      `PO_TOTALS_UNRECONCILED — lines sum to ${roundMoney(lineSum)} but the subtotal is ${o.subtotal}.`,
    );
  }
  if (Math.abs(Number(o.total) - (Number(o.subtotal) + Number(o.taxTotal) - Number(o.discountTotal))) > 0.01) {
    issues.push("PO_TOTALS_UNRECONCILED — total ≠ subtotal + tax − discount.");
  }
  return issues;
}
