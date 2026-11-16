/**
 * Operational Profitability Intelligence — canonical calculation contract.
 * Pure deterministic calculations only. Source acquisition, authorization and
 * snapshot persistence remain in the server orchestration layer.
 */
export type CostBasis = "actual" | "standard" | "estimated";
export type ReconciliationState =
  | "fully_reconciled"
  | "partially_reconciled"
  | "estimated"
  | "pending_expense_verification"
  | "unallocated_costs_present"
  | "incomplete_source_data";

export interface ProfitabilityCalculationInput {
  currency: string;
  grossSales: number;
  discounts: number;
  refunds: number;
  salesAdjustments: number;
  taxCollected: number;
  recipeCogs: number;
  recipeCostBasis: CostBasis;
  serviceConsumables: number;
  consumablesCostBasis: CostBasis;
  otherDirectVariableCosts: number;
  allocatedOperatingExpenses: number;
  unallocatedOperatingExpenses: number;
  pendingExpenseVerification: boolean;
  partiallyReconciled?: boolean;
  incompleteSourceData?: boolean;
}

export interface ProfitabilityCalculation {
  currency: string;
  grossSales: number;
  discounts: number;
  refunds: number;
  salesAdjustments: number;
  taxCollected: number;
  netSales: number;
  recipeCogs: number;
  recipeCostBasis: CostBasis;
  serviceConsumables: number;
  consumablesCostBasis: CostBasis;
  otherDirectVariableCosts: number;
  directVariableCosts: number;
  contribution: number;
  contributionMarginPercent: number | null;
  directVariableCostRatio: number | null;
  serviceConsumablesRatio: number | null;
  allocatedOperatingExpenses: number;
  unallocatedOperatingExpenses: number;
  operatingProfit: number;
  operatingMarginPercent: number | null;
  operatingExpenseRatio: number | null;
  reconciliationState: ReconciliationState;
}

const money = (value: number) => Number(value.toFixed(2));
const ratio = (value: number, denominator: number) =>
  denominator > 0 ? Number(((value / denominator) * 100).toFixed(2)) : null;

export function calculateOperationalProfitability(
  input: ProfitabilityCalculationInput,
): ProfitabilityCalculation {
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error("A valid property reporting currency is required.");
  }
  const fields: Array<keyof ProfitabilityCalculationInput> = [
    "grossSales", "discounts", "refunds", "salesAdjustments", "taxCollected",
    "recipeCogs", "serviceConsumables", "otherDirectVariableCosts",
    "allocatedOperatingExpenses", "unallocatedOperatingExpenses",
  ];
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid non-negative monetary amount: ${field}`);
    }
  }
  if (input.discounts + input.refunds + input.salesAdjustments + input.taxCollected > input.grossSales) {
    throw new Error("Revenue deductions and tax cannot exceed gross sales.");
  }

  const netSales = money(
    input.grossSales - input.discounts - input.refunds - input.salesAdjustments - input.taxCollected,
  );
  const directVariableCosts = money(
    input.recipeCogs + input.serviceConsumables + input.otherDirectVariableCosts,
  );
  const contribution = money(netSales - directVariableCosts);
  const operatingProfit = money(contribution - input.allocatedOperatingExpenses);
  const hasEstimatedCosts = input.recipeCostBasis !== "actual" || input.consumablesCostBasis !== "actual";
  const hasUnallocated = input.unallocatedOperatingExpenses > 0;
  const reconciliationState: ReconciliationState = input.incompleteSourceData
    ? "incomplete_source_data"
    : input.pendingExpenseVerification
      ? "pending_expense_verification"
      : hasUnallocated
      ? "unallocated_costs_present"
        : hasEstimatedCosts
          ? "estimated"
          : input.partiallyReconciled
            ? "partially_reconciled"
            : "fully_reconciled";

  return {
    currency: input.currency,
    grossSales: money(input.grossSales),
    discounts: money(input.discounts),
    refunds: money(input.refunds),
    salesAdjustments: money(input.salesAdjustments),
    taxCollected: money(input.taxCollected),
    netSales,
    recipeCogs: money(input.recipeCogs),
    recipeCostBasis: input.recipeCostBasis,
    serviceConsumables: money(input.serviceConsumables),
    consumablesCostBasis: input.consumablesCostBasis,
    otherDirectVariableCosts: money(input.otherDirectVariableCosts),
    directVariableCosts,
    contribution,
    contributionMarginPercent: ratio(contribution, netSales),
    directVariableCostRatio: ratio(directVariableCosts, netSales),
    serviceConsumablesRatio: ratio(input.serviceConsumables, netSales),
    allocatedOperatingExpenses: money(input.allocatedOperatingExpenses),
    unallocatedOperatingExpenses: money(input.unallocatedOperatingExpenses),
    operatingProfit,
    operatingMarginPercent: ratio(operatingProfit, netSales),
    operatingExpenseRatio: ratio(input.allocatedOperatingExpenses, netSales),
    reconciliationState,
  };
}
