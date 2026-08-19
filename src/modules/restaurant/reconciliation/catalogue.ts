/**
 * Sprint 5.12 — the exception catalogue.
 *
 * Reconciliation never invents a new source of truth: it compares what the
 * owning services already recorded and, where they disagree, names the
 * disagreement. Every name lives here so an exception means the same thing in
 * the detector, the UI, the document and the Intelligence Core.
 *
 * Browser-safe: pure data and pure functions only.
 */

export const RECONCILIATION_DOMAINS = ["cash", "payment", "sales", "inventory", "procurement"] as const;
export type ReconciliationDomain = (typeof RECONCILIATION_DOMAINS)[number];

export const EXCEPTION_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

/** Lifecycle. Nothing is ever auto-corrected; a human moves it. */
export const EXCEPTION_STATUSES = ["open", "reviewing", "resolved", "accepted", "dismissed"] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const CLOSED_EXCEPTION_STATUSES: readonly ExceptionStatus[] = ["resolved", "accepted", "dismissed"];

export const EXCEPTION_CODES = [
  // Cash / tender
  "cash.overage",
  "cash.shortage",
  "tender.declaration_missing",
  // Payment
  "payment.missing",
  "payment.duplicate",
  "payment.amount_mismatch",
  "payment.refund_without_original",
  "payment.refund_exceeds_original",
  "payment.room_charge_unposted",
  "payment.room_charge_unknown",
  "payment.room_charge_orphaned",
  // Sales chain
  "sales.closed_order_no_receipt",
  "sales.receipt_without_payment",
  "sales.paid_bill_outstanding",
  "sales.order_left_open",
  "sales.reopened_after_close",
  // Inventory
  "inventory.stocktake_variance",
  "inventory.ledger_drift",
  "inventory.negative_position",
  // Procurement
  "procurement.quantity_variance",
  "procurement.price_variance",
  "procurement.quality_rejection",
  "procurement.invoice_mismatch",
  "procurement.missing_invoice",
  "procurement.outstanding_supplier_amount",
] as const;
export type ExceptionCode = (typeof EXCEPTION_CODES)[number];

export interface ExceptionDefinition {
  code: ExceptionCode;
  domain: ReconciliationDomain;
  title: string;
  /** Default severity; detectors may raise it on materiality. */
  severity: ExceptionSeverity;
  requiredAction: string;
}

export const EXCEPTION_CATALOGUE: Record<ExceptionCode, ExceptionDefinition> = {
  "cash.overage": {
    code: "cash.overage",
    domain: "cash",
    title: "Cash overage",
    severity: "medium",
    requiredAction: "Recount the drawer and identify the unrecorded sale or float error before banking.",
  },
  "cash.shortage": {
    code: "cash.shortage",
    domain: "cash",
    title: "Cash shortage",
    severity: "high",
    requiredAction: "Recount the drawer, review voids and refunds for the shift, and record the explanation.",
  },
  "tender.declaration_missing": {
    code: "tender.declaration_missing",
    domain: "cash",
    title: "Tender not declared",
    severity: "medium",
    requiredAction: "Declare the counted amount for this payment method before closing the day.",
  },
  "payment.missing": {
    code: "payment.missing",
    domain: "payment",
    title: "Settled order without a payment record",
    severity: "high",
    requiredAction: "Capture the missing payment against the order, or reopen and settle it correctly.",
  },
  "payment.duplicate": {
    code: "payment.duplicate",
    domain: "payment",
    title: "Possible duplicate payment",
    severity: "high",
    requiredAction: "Confirm with the tender provider, then refund the duplicate through the POS.",
  },
  "payment.room_charge_unposted": {
    code: "payment.room_charge_unposted",
    domain: "payment",
    title: "Room charge recorded without a folio posting",
    severity: "critical",
    requiredAction:
      "Check the guest folio. If the charge is absent, post it manually or reopen the bill and take another tender.",
  },
  "payment.room_charge_unknown": {
    code: "payment.room_charge_unknown",
    domain: "payment",
    title: "Room charge with an unknown posting outcome",
    severity: "high",
    requiredAction: "Verify the folio with reception before retrying — the charge may already be on the stay.",
  },
  "payment.room_charge_orphaned": {
    code: "payment.room_charge_orphaned",
    domain: "payment",
    title: "Folio posting without a matching outlet payment",
    severity: "high",
    requiredAction: "The guest was charged but the outlet bill was not settled. Settle or reverse the posting.",
  },
  "payment.amount_mismatch": {
    code: "payment.amount_mismatch",
    domain: "payment",
    title: "Payments do not equal the recorded paid total",
    severity: "high",
    requiredAction: "Compare captured payments against the order and correct the settlement record.",
  },
  "payment.refund_without_original": {
    code: "payment.refund_without_original",
    domain: "payment",
    title: "Refund without a valid original payment",
    severity: "critical",
    requiredAction: "Identify the original tender; if none exists, escalate as a suspected unauthorised refund.",
  },
  "payment.refund_exceeds_original": {
    code: "payment.refund_exceeds_original",
    domain: "payment",
    title: "Refund exceeds the original payment",
    severity: "critical",
    requiredAction: "Review the refund authorisation and recover the over-refunded amount.",
  },
  "sales.closed_order_no_receipt": {
    code: "sales.closed_order_no_receipt",
    domain: "sales",
    title: "Closed order with no receipt issued",
    severity: "medium",
    requiredAction: "Issue the receipt from the order, or record why no fiscal document was produced.",
  },
  "sales.receipt_without_payment": {
    code: "sales.receipt_without_payment",
    domain: "sales",
    title: "Receipt issued without a settled payment",
    severity: "high",
    requiredAction: "Locate the tender for this receipt or void the receipt through the correct workflow.",
  },
  "sales.paid_bill_outstanding": {
    code: "sales.paid_bill_outstanding",
    domain: "sales",
    title: "Paid bill still showing an outstanding balance",
    severity: "medium",
    requiredAction: "Re-settle the order so the payment state matches the money actually received.",
  },
  "sales.order_left_open": {
    code: "sales.order_left_open",
    domain: "sales",
    title: "Order still open after service",
    severity: "medium",
    requiredAction: "Close or cancel the order with a reason so the business date can be closed.",
  },
  "sales.reopened_after_close": {
    code: "sales.reopened_after_close",
    domain: "sales",
    title: "Order reopened after the bill was settled",
    severity: "medium",
    requiredAction: "Confirm the reopen reason is authorised and that the revised total was re-settled.",
  },
  "inventory.stocktake_variance": {
    code: "inventory.stocktake_variance",
    domain: "inventory",
    title: "Counted stock differs from the expected ledger position",
    severity: "medium",
    requiredAction: "Recount, then post the adjustment with a reason code — the ledger stays the source of truth.",
  },
  "inventory.ledger_drift": {
    code: "inventory.ledger_drift",
    domain: "inventory",
    title: "Stored balance disagrees with the movement ledger",
    severity: "high",
    requiredAction: "Investigate manual writes; rebuild the position from the ledger rather than editing it.",
  },
  "inventory.negative_position": {
    code: "inventory.negative_position",
    domain: "inventory",
    title: "Negative stock position",
    severity: "high",
    requiredAction: "Find the unrecorded receipt or over-issued consumption and post the missing movement.",
  },
  "procurement.quantity_variance": {
    code: "procurement.quantity_variance",
    domain: "procurement",
    title: "Delivered quantity differs from the order",
    severity: "medium",
    requiredAction: "Agree the shortfall with the supplier and either close the order or expect a credit.",
  },
  "procurement.price_variance": {
    code: "procurement.price_variance",
    domain: "procurement",
    title: "Invoiced price differs from the agreed price",
    severity: "medium",
    requiredAction: "Challenge the invoice or update the agreed supplier price with authorisation.",
  },
  "procurement.quality_rejection": {
    code: "procurement.quality_rejection",
    domain: "procurement",
    title: "Goods rejected on quality",
    severity: "medium",
    requiredAction: "Confirm the credit note or replacement delivery from the supplier.",
  },
  "procurement.invoice_mismatch": {
    code: "procurement.invoice_mismatch",
    domain: "procurement",
    title: "Invoice fails three-way matching",
    severity: "high",
    requiredAction: "Resolve the order / receipt / invoice difference before releasing payment.",
  },
  "procurement.missing_invoice": {
    code: "procurement.missing_invoice",
    domain: "procurement",
    title: "Goods received without a supplier invoice",
    severity: "medium",
    requiredAction: "Chase the supplier invoice so the liability is recognised in the correct period.",
  },
  "procurement.outstanding_supplier_amount": {
    code: "procurement.outstanding_supplier_amount",
    domain: "procurement",
    title: "Supplier invoice overdue",
    severity: "medium",
    requiredAction: "Schedule payment or record the dispute against the invoice.",
  },
};

/** Materiality thresholds. Small differences are still surfaced, not hidden. */
export const MATERIALITY = {
  /** Money below this is treated as rounding, not as a variance. */
  moneyEpsilon: 0.01,
  /** Quantity noise floor for ledger comparisons. */
  quantityEpsilon: 1e-6,
  /** Absolute cash variance that escalates to "high". */
  cashHigh: 20_000,
  /** Absolute cash variance that escalates to "critical". */
  cashCritical: 100_000,
} as const;

export type CashOutcome = "balanced" | "overage" | "shortage";

export function classifyCashVariance(variance: number): CashOutcome {
  if (Math.abs(variance) <= MATERIALITY.moneyEpsilon) return "balanced";
  return variance > 0 ? "overage" : "shortage";
}

/** A shortage is always graver than the same overage: money left the till. */
export function cashSeverity(variance: number): ExceptionSeverity {
  const abs = Math.abs(variance);
  if (abs >= MATERIALITY.cashCritical) return "critical";
  if (abs >= MATERIALITY.cashHigh) return "high";
  if (variance < 0) return "high";
  return "medium";
}

export const SEVERITY_RANK: Record<ExceptionSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export interface ExceptionDraft {
  domain: ReconciliationDomain;
  code: ExceptionCode;
  severity: ExceptionSeverity;
  title: string;
  whatHappened: string;
  evidence: Record<string, unknown>;
  impactValue: number;
  requiredAction: string;
  entityType?: string | null;
  entityId?: string | null;
  dedupeKey: string;
}

/**
 * Builds a draft from the catalogue. `key` is the stable identity of the
 * *finding*, not of the run — re-running reconciliation for the same day must
 * never duplicate an exception.
 */
export function draftException(
  code: ExceptionCode,
  businessDate: string,
  key: string,
  detail: {
    whatHappened: string;
    evidence?: Record<string, unknown>;
    impactValue?: number;
    severity?: ExceptionSeverity;
    entityType?: string | null;
    entityId?: string | null;
  },
): ExceptionDraft {
  const def = EXCEPTION_CATALOGUE[code];
  return {
    domain: def.domain,
    code,
    severity: detail.severity ?? def.severity,
    title: def.title,
    whatHappened: detail.whatHappened,
    evidence: detail.evidence ?? {},
    impactValue: Number((detail.impactValue ?? 0).toFixed(2)),
    requiredAction: def.requiredAction,
    entityType: detail.entityType ?? null,
    entityId: detail.entityId ?? null,
    dedupeKey: `${code}:${businessDate}:${key}`,
  };
}