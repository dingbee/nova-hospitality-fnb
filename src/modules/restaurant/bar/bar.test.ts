import { describe, expect, it } from "vitest";
import { beverageCategories, isBeverageCategory } from "./lens";
import { pourCost, pourMargin, pourMaths, poursAvailable } from "./pour";

const ml = { id: "ml", code: "ml", name: "Millilitre", dimension: "volume", factor: 0.001 } as any;
const bottle = { id: "b", code: "btl", name: "Bottle 700ml", dimension: "volume", factor: 0.7 } as any;

describe("bar lens", () => {
  it("recognises beverage categories case-insensitively", () => {
    expect(isBeverageCategory("Spirits")).toBe(true);
    expect(isBeverageCategory("House Wine")).toBe(true);
    expect(isBeverageCategory("Grilled Meats")).toBe(false);
    expect(isBeverageCategory(undefined)).toBe(false);
  });

  it("returns only beverage categories, empty when none tagged", () => {
    expect(beverageCategories([{ name: "Beer" }, { name: "Starters" }])).toEqual([{ name: "Beer" }]);
    expect(beverageCategories([{ name: "Starters" }])).toEqual([]);
  });
});

describe("pour maths", () => {
  it("derives pours per bottle for a 30ml single", () => {
    const m = pourMaths({ servingSize: 30, servingUnit: ml, stockUnit: bottle });
    expect(m.exact).toBe(true);
    expect(m.poursPerStockUnit).toBeCloseTo(23.333333, 4);
  });

  it("does not subtract a whole bottle per pour", () => {
    const m = pourMaths({ servingSize: 30, servingUnit: ml, stockUnit: bottle });
    expect(m.stockPerPour!).toBeLessThan(0.05);
  });

  it("floors available pours and costs a single correctly", () => {
    const m = pourMaths({ servingSize: 60, servingUnit: ml, stockUnit: bottle });
    expect(poursAvailable(2, m)).toBe(23);
    expect(pourCost(70000, m)).toBeCloseTo(6000, 0);
  });

  it("reports margin for a sold drink", () => {
    const r = pourMargin(10000, 3000);
    expect(r.grossProfit).toBe(7000);
    expect(r.costPercent).toBe(30);
  });

  it("refuses an unconfigured pour", () => {
    const m = pourMaths({ servingSize: null, servingUnit: undefined, stockUnit: bottle });
    expect(m.exact).toBe(false);
    expect(poursAvailable(10, m)).toBeNull();
  });
});
