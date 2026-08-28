/**
 * Ops UAT gap #5 — low-stock intelligence didn't flag a shortage after
 * moving stock out via a transfer.
 *
 * Root cause: inventoryFindings only produced an inventory_shortage finding
 * when daysOfCover was a real number (projected from consumption velocity).
 * An item that just dropped below its reorder point via a transfer (or any
 * non-sales movement) has zero measured consumption, so daysOfCover is
 * null — and the finding was silently dropped even though
 * getInventoryIntelligence's own atRisk list already correctly included
 * the row for being belowReorder. The insights/dashboard layer already
 * handled this null-days case; the findings layer (what actually reaches
 * the decision engine) didn't.
 */
import { describe, expect, it } from "vitest";
import { inventoryFindings } from "./findings";
import type { InventoryIntelligence } from "../intelligence/types";

function baseIntelligence(overrides: Partial<InventoryIntelligence> = {}): InventoryIntelligence {
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    currency: "TZS",
    runway: [],
    atRisk: [],
    wastage: { currentCost: 0, previousCost: 0, changePercent: null, topItems: [] },
    priceThreats: [],
    insights: [],
    ...overrides,
  };
}

describe("inventoryFindings — shortage detection", () => {
  it("flags an item already below its reorder point even with zero measured velocity (the reported gap)", () => {
    const inv = baseIntelligence({
      atRisk: [
        {
          inventoryItemId: "item-1",
          name: "UAT receiving ingredient",
          currentQuantity: 1,
          dailyVelocity: 0,
          daysOfCover: null,
          reorderPoint: 5,
          belowReorder: true,
        },
      ],
    });

    const findings = inventoryFindings(inv);
    const shortage = findings.find((f) => f.kind === "inventory_shortage");

    expect(shortage).toBeDefined();
    expect(shortage!.headline).toMatch(/already below its reorder point/i);
    expect(shortage!.metric).toBe("below reorder point");
    expect(shortage!.facts.belowReorder).toBe(true);
    expect(shortage!.facts.daysOfCover).toBeNull();
    expect(shortage!.facts.urgent).toBe(true);
  });

  it("still flags a velocity-projected stock-out exactly as before", () => {
    const inv = baseIntelligence({
      atRisk: [
        {
          inventoryItemId: "item-2",
          name: "Fast mover",
          currentQuantity: 6,
          dailyVelocity: 3,
          daysOfCover: 2,
          reorderPoint: null,
          belowReorder: false,
        },
      ],
    });

    const findings = inventoryFindings(inv);
    const shortage = findings.find((f) => f.kind === "inventory_shortage");

    expect(shortage).toBeDefined();
    expect(shortage!.severity).toBe("high"); // days <= 2
    expect(shortage!.headline).toMatch(/run out in 2 days/i);
    expect(shortage!.facts.daysOfCover).toBe(2);
  });

  it("does not flag an item that is neither below reorder nor projected to run out", () => {
    const inv = baseIntelligence({
      atRisk: [], // getInventoryIntelligence itself would never include this row
    });
    expect(inventoryFindings(inv).filter((f) => f.kind === "inventory_shortage")).toHaveLength(0);
  });

  it("an item with plenty of days of cover and no reorder point never appears even if passed in atRisk by mistake", () => {
    const inv = baseIntelligence({
      atRisk: [
        {
          inventoryItemId: "item-3",
          name: "Well stocked",
          currentQuantity: 100,
          dailyVelocity: 1,
          daysOfCover: 100,
          reorderPoint: null,
          belowReorder: false,
        },
      ],
    });
    expect(inventoryFindings(inv).filter((f) => f.kind === "inventory_shortage")).toHaveLength(0);
  });
});
