import { describe, expect, it } from "vitest";
import {
  activeReservedQuantity,
  calculateReplenishment,
  calculateStockPosition,
  comparableSupplierUnitCost,
  forecastDailyDemand,
  stockUnitsPerUnit,
} from "./stock-position.contract";

describe("canonical stock-position contract", () => {
  const asOf = "2026-11-16T12:00:00.000Z";
  const horizonEnd = "2026-11-26T12:00:00.000Z";

  it("nets on-hand, active reservations and eligible inbound exactly once", () => {
    const result = calculateStockPosition({
      onHand: 20,
      reservations: [
        { id: "active", quantity: 4, status: "active", expiresAt: null },
        { id: "released", quantity: 3, status: "released", expiresAt: null },
      ],
      inbound: [
        { sourceId: "po-1", sourceType: "purchase_order", quantityInStockUnits: 5, expectedAt: "2026-11-20T00:00:00Z", status: "approved" },
        { sourceId: "transfer-1", sourceType: "stock_transfer", quantityInStockUnits: 2, expectedAt: "2026-11-21T00:00:00Z", status: "dispatched" },
        { sourceId: "partial-po", sourceType: "purchase_order", quantityInStockUnits: 3, acceptedQuantityInStockUnits: 7, rejectedQuantityInStockUnits: 1, expectedAt: "2026-11-22T00:00:00Z", status: "partially_received" },
        { sourceId: "late-po", sourceType: "purchase_order", quantityInStockUnits: 9, expectedAt: "2026-12-20T00:00:00Z", status: "approved" },
      ],
      asOf,
      horizonEnd,
    });
    expect(result).toMatchObject({
      onHand: 20,
      reserved: 4,
      purchaseOrderInbound: 8,
      inTransitInbound: 2,
      confirmedDeliveryInbound: 0,
      netAvailable: 26,
    });
    expect(result.components.map((row) => row.sourceId)).toEqual(["partial-po", "po-1", "transfer-1"]);
  });

  it("does not count expired reservations or cancelled, rejected, completed or undated inbound", () => {
    expect(activeReservedQuantity([
      { id: "expired", quantity: 8, status: "active", expiresAt: "2026-11-15T00:00:00Z" },
      { id: "still-active", quantity: 2, status: "active", expiresAt: "2026-11-17T00:00:00Z" },
    ], asOf)).toBe(2);
    const result = calculateStockPosition({
      onHand: 10,
      reservations: [],
      inbound: [
        { sourceId: "cancelled", sourceType: "purchase_order", quantityInStockUnits: 10, expectedAt: "2026-11-20T00:00:00Z", status: "cancelled" },
        { sourceId: "rejected", sourceType: "purchase_order", quantityInStockUnits: 10, expectedAt: "2026-11-20T00:00:00Z", status: "rejected" },
        { sourceId: "received", sourceType: "purchase_order", quantityInStockUnits: 10, expectedAt: "2026-11-20T00:00:00Z", status: "received" },
        { sourceId: "unknown-date", sourceType: "purchase_order", quantityInStockUnits: 10, expectedAt: null, status: "approved" },
      ],
      asOf,
      horizonEnd,
    });
    expect(result.netAvailable).toBe(10);
    expect(result.components).toHaveLength(0);
  });

  it("does not fabricate demand when history is insufficient", () => {
    expect(forecastDailyDemand([1, 2, 0, 3, 1, 2, 0, 0, 0, 0], 10, 7, 6)).toMatchObject({
      status: "insufficient_history",
      dailyAverage: null,
      forecastQuantity: null,
      confidence: "none",
    });
  });

  it("produces a deterministic daily forecast and flags a spike", () => {
    const result = forecastDailyDemand([1, 1, 2, 1, 1, 2, 1, 1, 50, 1, 1, 2, 1, 1], 7, 7, 14);
    expect(result.status).toBe("ready");
    expect(result.outlierDays).toContain(8);
    expect(result.dailyAverage).toBeLessThan(5);
    expect(result.forecastQuantity).toBe(Number(((result.dailyAverage ?? 0) * 7).toFixed(4)));
  });

  it("does not recommend a purchase when net available stock covers forecast and safety stock", () => {
    expect(calculateReplenishment({
      forecastDemand: 10,
      safetyStock: 2,
      netAvailable: 15,
      leadTimeDays: 4,
      targetCoverageDays: 3,
      stockUnitsPerPurchaseUnit: 12,
    })).toMatchObject({
      status: "ready",
      requiredStockUnits: 0,
      recommendedPurchaseUnits: 0,
      recommendedStockUnits: 0,
    });
  });

  it("rounds replenishment to supplier pack and order multiples", () => {
    expect(calculateReplenishment({
      forecastDemand: 20,
      safetyStock: 3,
      netAvailable: 5,
      leadTimeDays: 4,
      targetCoverageDays: 3,
      stockUnitsPerPurchaseUnit: 12,
      minimumOrderQuantity: 2,
      orderMultiple: 2,
    })).toMatchObject({
      status: "ready",
      horizonDays: 7,
      requiredStockUnits: 18,
      recommendedPurchaseUnits: 2,
      recommendedStockUnits: 24,
    });
  });

  it("requires manual review when supplier order multiple is missing", () => {
    expect(calculateReplenishment({
      forecastDemand: 10,
      safetyStock: 2,
      netAvailable: 1,
      leadTimeDays: 3,
      targetCoverageDays: 7,
      stockUnitsPerPurchaseUnit: 1,
      minimumOrderQuantity: 0,
    })).toMatchObject({
      status: "manual_review",
      recommendedPurchaseUnits: null,
      recommendedStockUnits: null,
      reason: "Supplier minimum order quantity or order multiple is invalid.",
    });
  });

  it("requires manual review when lead time or unit conversion is missing", () => {
    expect(calculateReplenishment({
      forecastDemand: 10, safetyStock: 2, netAvailable: 1,
      leadTimeDays: null, targetCoverageDays: 7, stockUnitsPerPurchaseUnit: 1,
    }).status).toBe("manual_review");
    expect(calculateReplenishment({
      forecastDemand: 10, safetyStock: 2, netAvailable: 1,
      leadTimeDays: 3, targetCoverageDays: 7, stockUnitsPerPurchaseUnit: null,
    }).status).toBe("manual_review");
  });

  it("resolves unit conversion only from exact units, compatible unit factors or configured pack size", () => {
    const units = [
      { id: "kg", dimension: "mass", base_unit_id: "base-mass", factor: 1 },
      { id: "g", dimension: "mass", base_unit_id: "base-mass", factor: 0.001 },
      { id: "litre", dimension: "volume", base_unit_id: "base-volume", factor: 1 },
    ];
    expect(stockUnitsPerUnit("kg", "g", null, null, units)).toBe(1000);
    expect(stockUnitsPerUnit("litre", "g", null, null, units)).toBeNull();
    expect(stockUnitsPerUnit("carton", "bottle", "carton", 12, [])).toBe(12);
    expect(stockUnitsPerUnit("unknown", "bottle", null, null, [])).toBeNull();
  });

  it("compares prices only when currencies and stock-unit conversions are comparable", () => {
    expect(comparableSupplierUnitCost(48000, "TZS", "TZS", 12)).toBe(4000);
    expect(comparableSupplierUnitCost(4500, "TZS", "TZS", 1)).toBe(4500);
    expect(comparableSupplierUnitCost(20, "USD", "TZS", 12)).toBeNull();
    expect(comparableSupplierUnitCost(20, "TZS", "TZS", 0)).toBeNull();
  });
});
