import { describe, expect, it } from "vitest";
import { aggregateReconciledRevenue, type RevenueEvent } from "./revenue-reconciliation";

const event = (overrides: Partial<RevenueEvent>): RevenueEvent => ({
  id: "e1",
  economicEventKey: "booking-1",
  propertyId: "p1",
  source: "staynas",
  category: "accommodation",
  currency: "TZS",
  amount: 100,
  state: "posted",
  reconciliation: "reconciled",
  ...overrides,
});

describe("LB-04 combined revenue reconciliation", () => {
  it("combines only canonical reconciled revenue by property and currency", () => {
    const result = aggregateReconciledRevenue([
      event({ id: "room", economicEventKey: "stay-1", amount: 100 }),
      event({ id: "pos", economicEventKey: "pos-1", source: "lexibite", category: "food_beverage", amount: 50 }),
      event({ id: "wrong-source", economicEventKey: "pos-folio-copy", source: "staynas", category: "food_beverage", amount: 50 }),
      event({ id: "pending-pos", economicEventKey: "pos-2", source: "lexibite", category: "food_beverage", reconciliation: "pending", amount: 25 }),
    ]);
    expect(result.totals).toEqual([{
      propertyId: "p1",
      currency: "TZS",
      accommodationRevenue: 100,
      foodBeverageRevenue: 50,
      combinedRevenue: 150,
      eventCount: 2,
    }]);
    expect(result.reconciliationRequired).toBe(true);
    expect(result.exclusions.map((item) => item.reason)).toContain("non_canonical_source");
  });

  it("removes reversed events and flags duplicate economic events", () => {
    const result = aggregateReconciledRevenue([
      event({ id: "original", economicEventKey: "stay-1", amount: 100 }),
      event({ id: "reversal", economicEventKey: "reversal-1", state: "reversed", reversesEventId: "original", amount: 100 }),
      event({ id: "dup-a", economicEventKey: "duplicate", amount: 30 }),
      event({ id: "dup-b", economicEventKey: "duplicate", amount: 30 }),
    ]);
    expect(result.totals).toEqual([]);
    expect(result.exclusions.filter((item) => item.reason === "duplicate_economic_event")).toHaveLength(2);
    expect(result.reconciliationRequired).toBe(true);
  });

  it("treats a linked reversal as resolved but flags a reversal without its original", () => {
    const matched = aggregateReconciledRevenue([
      event({ id: "original", economicEventKey: "stay-1" }),
      event({ id: "reversal", economicEventKey: "reversal-1", state: "reversed", reversesEventId: "original" }),
    ]);
    const unmatched = aggregateReconciledRevenue([
      event({ id: "orphan-reversal", economicEventKey: "reversal-2", state: "reversed" }),
    ]);
    expect(matched.totals).toEqual([]);
    expect(matched.reconciliationRequired).toBe(false);
    expect(unmatched.reconciliationRequired).toBe(true);
  });

  it("keeps currencies separate and never applies FX", () => {
    const result = aggregateReconciledRevenue([
      event({ id: "tzs", economicEventKey: "stay-1", amount: 100, currency: "TZS" }),
      event({ id: "usd", economicEventKey: "stay-2", amount: 20, currency: "USD" }),
    ]);
    expect(result.totals.map((item) => item.currency)).toEqual(["TZS", "USD"]);
    expect(result.totals.map((item) => item.combinedRevenue)).toEqual([100, 20]);
  });

  it("does not count a room-charge folio copy as a second F&B event", () => {
    const result = aggregateReconciledRevenue([
      event({ id: "pos-room-charge", economicEventKey: "pos-order-7", source: "lexibite", category: "food_beverage", amount: 75 }),
      event({ id: "folio-copy", economicEventKey: "pos-order-7", source: "staynas", category: "food_beverage", amount: 75 }),
    ]);
    expect(result.totals[0]?.foodBeverageRevenue).toBe(75);
    expect(result.totals[0]?.eventCount).toBe(1);
    expect(result.exclusions[0]?.reason).toBe("non_canonical_source");
  });

  it("flags the same economic event presented in two revenue categories", () => {
    const result = aggregateReconciledRevenue([
      event({ id: "room-event", economicEventKey: "event-9", amount: 100 }),
      event({ id: "pos-event", economicEventKey: "event-9", source: "lexibite", category: "food_beverage", amount: 100 }),
    ]);
    expect(result.totals).toEqual([]);
    expect(result.exclusions.filter((item) => item.reason === "duplicate_economic_event")).toHaveLength(2);
    expect(result.reconciliationRequired).toBe(true);
  });
});
