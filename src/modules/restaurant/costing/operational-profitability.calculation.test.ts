import { describe, expect, it } from "vitest";
import { calculateOperationalProfitability } from "./operational-profitability.calculation";

const base = {
  currency: "TZS",
  grossSales: 20000,
  discounts: 0,
  refunds: 0,
  salesAdjustments: 0,
  taxCollected: 0,
  recipeCogs: 7000,
  recipeCostBasis: "actual" as const,
  serviceConsumables: 950,
  consumablesCostBasis: "actual" as const,
  otherDirectVariableCosts: 0,
  allocatedOperatingExpenses: 0,
  unallocatedOperatingExpenses: 0,
  pendingExpenseVerification: false,
};

describe("calculateOperationalProfitability", () => {
  it("reconciles the canonical takeaway example", () => {
    const result = calculateOperationalProfitability(base);
    expect(result).toMatchObject({
      netSales: 20000,
      recipeCogs: 7000,
      serviceConsumables: 950,
      directVariableCosts: 7950,
      contribution: 12050,
      operatingProfit: 12050,
      reconciliationState: "fully_reconciled",
    });
  });

  it("excludes discounts, refunds, adjustments and tax from restaurant net sales", () => {
    const result = calculateOperationalProfitability({
      ...base, grossSales: 30000, discounts: 1000, refunds: 500,
      salesAdjustments: 500, taxCollected: 3000,
    });
    expect(result.netSales).toBe(25000);
  });

  it("keeps unallocated expenses visible without subtracting them from outlet operating profit", () => {
    const result = calculateOperationalProfitability({
      ...base, allocatedOperatingExpenses: 2000, unallocatedOperatingExpenses: 5000,
    });
    expect(result.operatingProfit).toBe(10050);
    expect(result.unallocatedOperatingExpenses).toBe(5000);
    expect(result.reconciliationState).toBe("unallocated_costs_present");
  });

  it("labels standard recipe cost as estimated rather than actual", () => {
    const result = calculateOperationalProfitability({ ...base, recipeCostBasis: "standard" });
    expect(result.recipeCostBasis).toBe("standard");
    expect(result.reconciliationState).toBe("estimated");
  });

  it("marks pending expense verification above other confidence states", () => {
    const result = calculateOperationalProfitability({
      ...base, pendingExpenseVerification: true, pendingExpenseAmount: 300, unallocatedOperatingExpenses: 100,
    });
    expect(result.reconciliationState).toBe("pending_expense_verification");
    expect(result.pendingExpenseAmount).toBe(300);
  });

  it("returns unavailable margins when net sales are zero", () => {
    const result = calculateOperationalProfitability({ ...base, grossSales: 0, recipeCogs: 0, serviceConsumables: 0 });
    expect(result.contributionMarginPercent).toBeNull();
    expect(result.operatingMarginPercent).toBeNull();
  });

  it("rejects missing/invalid currency rather than falling back to TZS or USD", () => {
    expect(() => calculateOperationalProfitability({ ...base, currency: "" })).toThrow(
      "A valid property reporting currency is required.",
    );
  });

  it("rejects negative monetary source values", () => {
    expect(() => calculateOperationalProfitability({ ...base, serviceConsumables: -1 })).toThrow(
      "Invalid non-negative monetary amount: serviceConsumables",
    );
  });
});
