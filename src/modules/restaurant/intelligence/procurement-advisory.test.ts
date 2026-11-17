import { describe, expect, it } from "vitest";
import { adviseProcurement } from "./procurement-advisory";

const base = {
  inventoryItemId: "rice",
  currency: "TZS",
  stockUnit: "kg",
  supplierUnit: "kg",
  averageDailyUsage: 10,
  onHand: 40,
  reserved: 5,
  openPurchaseOrderQuantity: 5,
  supplierLeadTimeDays: 5,
  minimumOrderQuantity: 20,
  packSize: 10,
  supplierUnitPrice: 3200,
  supplierCurrency: "TZS",
  shelfLifeDays: 180,
};

describe("LB-04 procurement advisory", () => {
  it("uses live stock commitments, lead time, MOQ and pack multiple", () => {
    const result = adviseProcurement(base);
    expect(result.status).toBe("recommend_order");
    expect(result.availableAfterCommitments).toBe(40);
    expect(result.leadTimeDemand).toBe(50);
    expect(result.daysOfCover).toBe(4);
    expect(result.suggestedQuantity).toBe(20);
    expect(result.estimatedCost).toBe(64000);
  });

  it("does not recommend ordering when commitments cover lead-time demand", () => {
    const result = adviseProcurement({ ...base, onHand: 100 });
    expect(result.status).toBe("no_action");
    expect(result.suggestedQuantity).toBe(0);
  });

  it("withholds calculations when units or currencies do not match", () => {
    expect(adviseProcurement({ ...base, supplierUnit: "bag" }).status).toBe("unit_mismatch");
    expect(adviseProcurement({ ...base, supplierCurrency: "USD" }).status).toBe("currency_mismatch");
  });

  it("does not infer usage or write inventory", () => {
    const result = adviseProcurement({ ...base, averageDailyUsage: 0 });
    expect(result.status).toBe("no_action");
    expect(result.suggestedQuantity).toBe(0);
    expect(base.onHand).toBe(40);
    expect(base.openPurchaseOrderQuantity).toBe(5);
  });

  it("withholds cost when supplier price or currency is unavailable", () => {
    const noPrice = adviseProcurement({ ...base, supplierUnitPrice: null });
    const noCurrency = adviseProcurement({ ...base, supplierCurrency: null });
    expect(noPrice.suggestedQuantity).toBe(20);
    expect(noPrice.estimatedCost).toBeNull();
    expect(noCurrency.suggestedQuantity).toBe(20);
    expect(noCurrency.estimatedCost).toBeNull();
  });

  it("rejects fractional lead times and invalid supplier terms", () => {
    expect(adviseProcurement({ ...base, supplierLeadTimeDays: 1.5 }).status).toBe("insufficient_data");
    expect(adviseProcurement({ ...base, supplierUnitPrice: -1 }).status).toBe("insufficient_data");
  });
});
