/**
 * LB-04 deterministic procurement advisory.
 *
 * Inputs are property-scoped projections from LexiBite's inventory,
 * supplier-product and purchase-order records. This function is advisory only:
 * it never changes stock, creates purchase orders, or performs FX.
 */
export interface ProcurementAdvisoryInput {
  inventoryItemId: string;
  currency: string;
  stockUnit: string;
  supplierUnit: string;
  averageDailyUsage: number | null;
  onHand: number;
  reserved: number;
  openPurchaseOrderQuantity: number;
  supplierLeadTimeDays: number | null;
  minimumOrderQuantity: number | null;
  packSize: number | null;
  supplierUnitPrice: number | null;
  supplierCurrency: string | null;
  shelfLifeDays: number | null;
}

export interface ProcurementAdvisory {
  inventoryItemId: string;
  status: "recommend_order" | "no_action" | "insufficient_data" | "unit_mismatch" | "currency_mismatch";
  currency: string;
  availableAfterCommitments: number | null;
  leadTimeDemand: number | null;
  daysOfCover: number | null;
  suggestedQuantity: number | null;
  estimatedCost: number | null;
  supplierLeadTimeDays: number | null;
  shelfLifeDays: number | null;
  rationale: string;
  limitations: string[];
}

const nonNegative = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;

/** Calculates a non-mutating replenishment suggestion from lead-time demand. */
export function adviseProcurement(input: ProcurementAdvisoryInput): ProcurementAdvisory {
  const base = {
    inventoryItemId: input.inventoryItemId,
    currency: input.currency,
    supplierLeadTimeDays: input.supplierLeadTimeDays,
    shelfLifeDays: input.shelfLifeDays,
    limitations: ["Advisory only: no stock movement or purchase order is created."],
  };
  const result = (
    status: ProcurementAdvisory["status"],
    rationale: string,
    values: Partial<ProcurementAdvisory> = {},
  ): ProcurementAdvisory => ({
    ...base,
    status,
    availableAfterCommitments: null,
    leadTimeDemand: null,
    daysOfCover: null,
    suggestedQuantity: null,
    estimatedCost: null,
    rationale,
    ...values,
  });

  if (!/^[A-Z]{3}$/.test(input.currency) || !nonNegative(input.onHand) ||
      !nonNegative(input.reserved) || !nonNegative(input.openPurchaseOrderQuantity) ||
      !nonNegative(input.averageDailyUsage) || !nonNegative(input.supplierLeadTimeDays)) {
    return result("insufficient_data", "Valid currency, stock commitments, daily usage and supplier lead time are required.");
  }
  if (!input.stockUnit || !input.supplierUnit || input.stockUnit !== input.supplierUnit) {
    return result("unit_mismatch", "Stock and supplier purchasing units must match; no implicit unit conversion is applied.");
  }
  if (input.supplierCurrency !== null && input.supplierCurrency !== input.currency) {
    return result("currency_mismatch", "Supplier and property currencies differ; no FX conversion is applied.");
  }
  if (input.averageDailyUsage === 0) {
    return result("no_action", "No positive daily usage is recorded; replenishment quantity is not inferred.", {
      availableAfterCommitments: Math.max(0, input.onHand - input.reserved + input.openPurchaseOrderQuantity),
      leadTimeDemand: 0,
      daysOfCover: null,
      suggestedQuantity: 0,
      estimatedCost: input.supplierUnitPrice !== null && nonNegative(input.supplierUnitPrice) ? 0 : null,
    });
  }
  if (input.minimumOrderQuantity !== null && !nonNegative(input.minimumOrderQuantity) ||
      input.packSize !== null && (!nonNegative(input.packSize) || input.packSize === 0) ||
      input.supplierUnitPrice !== null && !nonNegative(input.supplierUnitPrice)) {
    return result("insufficient_data", "Supplier MOQ, pack size or unit price contains an invalid value.");
  }

  const available = Math.max(0, input.onHand - input.reserved + input.openPurchaseOrderQuantity);
  const leadTimeDemand = input.averageDailyUsage * input.supplierLeadTimeDays;
  const daysOfCover = available / input.averageDailyUsage;
  const deficit = Math.max(0, leadTimeDemand - available);
  if (deficit === 0) {
    return result("no_action", "Available stock and open purchase orders cover forecast consumption through supplier lead time.", {
      availableAfterCommitments: available,
      leadTimeDemand,
      daysOfCover,
      suggestedQuantity: 0,
      estimatedCost: input.supplierUnitPrice === null ? null : 0,
    });
  }

  const minimum = input.minimumOrderQuantity ?? 0;
  const pack = input.packSize ?? 1;
  const quantity = Math.ceil(Math.max(deficit, minimum) / pack) * pack;
  const cost = input.supplierUnitPrice === null ? null : Math.round(quantity * input.supplierUnitPrice * 100) / 100;
  return result("recommend_order", "Projected stock cover is below supplier lead time; suggested quantity covers the lead-time deficit, supplier MOQ and pack multiple.", {
    availableAfterCommitments: available,
    leadTimeDemand,
    daysOfCover,
    suggestedQuantity: quantity,
    estimatedCost: cost,
    limitations: [
      "Advisory only: no stock movement or purchase order is created.",
      input.shelfLifeDays === null ? "Shelf-life data is unavailable and must be checked before ordering." : "Shelf-life is surfaced for operator review; demand timing and expiry allocation are not modelled.",
      input.supplierUnitPrice === null ? "Supplier price is unavailable; estimated cost is withheld." : "Estimated cost uses the latest supplied unit price and does not include tax or freight.",
    ],
  });
}
