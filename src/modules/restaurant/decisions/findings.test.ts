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
import type { InventoryIntelligence, PurchaseSuggestion } from "../intelligence/types";

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

/**
 * I5 — the shortage finding must carry the same structured, executable
 * facts (inventoryItemId/recommendedQuantity/supplierId/...) a
 * purchasing_replenishment finding already carries, so
 * decisions/actions.server.ts's runProcurementDraftExecution can turn a
 * "current quantity < reorder point" recommendation into a real procurement
 * request line — without inventoryFindings recomputing the quantity or
 * supplier itself. It is only ever a lookup against the already-computed
 * PurchasingIntelligence.suggestions (O6's recommendedPurchaseQuantity and
 * purchasing.server.ts's existing supplier-selection, untouched by I5).
 */
describe("inventoryFindings — I5 replenishment facts", () => {
  function suggestion(overrides: Partial<PurchaseSuggestion> = {}): PurchaseSuggestion {
    return {
      inventoryItemId: "item-1",
      name: "UAT receiving ingredient",
      currentQuantity: 1,
      dailyVelocity: 2,
      leadTimeDays: 3,
      coverDays: 7,
      recommendedQuantity: 22,
      estimatedCost: 33000,
      supplierName: "UAT supplier",
      supplierId: "supplier-1",
      ...overrides,
    };
  }

  it("enriches a below-reorder shortage with the exact recommendedQuantity/supplier the purchasing calculation already produced", () => {
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

    const findings = inventoryFindings(inv, [suggestion()]);
    const shortage = findings.find((f) => f.kind === "inventory_shortage");

    // Never a second interpretation of the quantity — identical to the
    // value purchasing.server.ts's recommendedPurchaseQuantity computed.
    expect(shortage!.facts.recommendedQuantity).toBe(22);
    expect(shortage!.facts.supplierId).toBe("supplier-1");
    expect(shortage!.facts.inventoryItemId).toBe("item-1");
    expect(shortage!.facts.currentQuantity).toBe(1);
    expect(shortage!.facts.reorderPoint).toBe(5);
    expect(shortage!.facts.estimatedCost).toBe(33000);
    expect(shortage!.facts.estimatedUnitCost).toBeCloseTo(33000 / 22);
    expect(shortage!.facts.currency).toBe("TZS");
  });

  it("leaves recommendedQuantity/supplierId null — never a guess — when no matching purchasing suggestion exists", () => {
    const inv = baseIntelligence({
      atRisk: [
        {
          inventoryItemId: "item-no-match",
          name: "Idle item",
          currentQuantity: 2,
          dailyVelocity: 0,
          daysOfCover: null,
          reorderPoint: 10,
          belowReorder: true,
        },
      ],
    });

    // A suggestion exists, but for a different item — must not leak across.
    const findings = inventoryFindings(inv, [suggestion({ inventoryItemId: "item-1" })]);
    const shortage = findings.find((f) => f.kind === "inventory_shortage");

    expect(shortage!.facts.recommendedQuantity).toBeNull();
    expect(shortage!.facts.supplierId).toBeNull();
    expect(shortage!.facts.estimatedUnitCost).toBeNull();
  });

  it("omitting the suggestions argument entirely still raises the finding, just without the structured purchasing fields (back-compat)", () => {
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

    const shortage = inventoryFindings(inv).find((f) => f.kind === "inventory_shortage");
    expect(shortage).toBeDefined();
    expect(shortage!.facts.recommendedQuantity).toBeNull();
    expect(shortage!.facts.supplierId).toBeNull();
  });
});
