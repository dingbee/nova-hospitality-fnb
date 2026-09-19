import { describe, expect, it } from "vitest";
import { firstUnmetRequiredGroup, modifierTotalPerUnit, quickTenders, resolveUnitPrice } from "./pos-money";

describe("resolveUnitPrice", () => {
  it("falls back to the item base price with no variant", () => {
    expect(resolveUnitPrice({ price: 28000 }, undefined)).toBe(28000);
  });

  it("adds a delta variant onto the base price", () => {
    expect(resolveUnitPrice({ price: 28000 }, { price: 4000, price_is_delta: true })).toBe(32000);
  });

  it("replaces the base price for a non-delta variant", () => {
    expect(resolveUnitPrice({ price: 28000 }, { price: 35000, price_is_delta: false })).toBe(35000);
  });
});

describe("modifierTotalPerUnit", () => {
  it("sums price delta times quantity across chosen modifiers", () => {
    expect(
      modifierTotalPerUnit([
        { name: "Extra cheese", priceDelta: 1500, quantity: 1 },
        { name: "Bacon", priceDelta: 2000, quantity: 2 },
      ]),
    ).toBe(1500 + 4000);
  });

  it("is zero for no modifiers", () => {
    expect(modifierTotalPerUnit([])).toBe(0);
  });
});

describe("firstUnmetRequiredGroup", () => {
  const groups = [
    { id: "g1", required: true, min_select: 1 },
    { id: "g2", required: false, min_select: 1 },
  ];

  it("flags a required group with no selection yet", () => {
    expect(firstUnmetRequiredGroup(groups, [])?.id).toBe("g1");
  });

  it("is satisfied once the minimum is chosen", () => {
    expect(firstUnmetRequiredGroup(groups, [{ groupId: "g1" }])).toBeUndefined();
  });

  it("never flags a non-required group", () => {
    expect(firstUnmetRequiredGroup(groups, [{ groupId: "g1" }])).toBeUndefined();
  });
});

describe("quickTenders", () => {
  it("offers rounded notes at or above the balance", () => {
    expect(quickTenders(28000)).toEqual([28000, 30000, 40000, 50000]);
  });

  it("is empty for a zero balance", () => {
    expect(quickTenders(0)).toEqual([]);
  });
});
