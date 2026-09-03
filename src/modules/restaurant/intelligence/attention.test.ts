/* eslint-disable @typescript-eslint/no-explicit-any -- minimal fixture Decisions/Findings, only the fields each function reads matter here. */
/**
 * I14 "NOVA OPERATIONAL INTELLIGENCE" — attention.ts.
 *
 * Every function under test is pure and reprojects existing fields; these
 * tests prove: severity ranking is stable and reuses Decision.riskLevel/
 * confidence verbatim (never a new score), topPriorities never invents
 * text, detectMaterialChanges only fires above a documented threshold and
 * only on fields the engines already computed, correlateFindingsByEntity
 * only links findings sharing a REAL entity id (never a name match) and
 * always uses non-causal language, and role trimming fails closed.
 */
import { describe, expect, it } from "vitest";
import {
  MATERIAL_CHANGE_THRESHOLD_PERCENT,
  contextSectionsForRole,
  correlateFindingsByEntity,
  detectMaterialChanges,
  rankByAttention,
  topPriorities,
  trimContextForRoles,
} from "./attention";
import type { RestaurantFinding, RestaurantStoredDecision } from "../decisions/decision.types";

function decision(overrides: Partial<RestaurantStoredDecision> = {}): RestaurantStoredDecision {
  return {
    key: "restaurant.t1.finding.x",
    module: "restaurant",
    domain: "inventory",
    title: "Test decision",
    trigger: "Something happened",
    status: "proposed",
    riskLevel: "medium",
    confidence: 0.6,
    requiresApproval: true,
    criteriaWeights: {} as any,
    constraints: [],
    options: [],
    recommendedOptionKey: null,
    reasoning: {
      whatIsHappening: "x",
      whyItMatters: "It matters because Y",
      whatIsLikely: "Likely Z will happen",
      optionsConsidered: [],
      tradeOffs: [],
      selectedOption: "Option A",
      whySelected: "Because",
      whatCouldGoWrong: [],
      whatHappensNext: ["Review replenishment"],
    },
    expectedOutcomes: [],
    evidence: [{ label: "Stock", value: "8kg" }],
    assumptions: [],
    uncertainties: [],
    risks: [],
    reasoningSources: [],
    predictionKeys: [],
    plan: { objective: "x", status: "draft", steps: [] },
    action: null,
    ...overrides,
  } as RestaurantStoredDecision;
}

function finding(overrides: Partial<RestaurantFinding> = {}): RestaurantFinding {
  return {
    key: "finding.x",
    kind: "inventory_shortage",
    severity: "high",
    subject: "Beef",
    headline: "Beef is running low",
    detail: "detail",
    metric: null,
    evidence: [],
    prediction: {
      key: "prediction.x",
      statement: "statement",
      value: null,
      unit: "",
      horizonDays: 3,
      confidence: 0.7,
      direction: "down",
    },
    facts: {},
    ...overrides,
  };
}

describe("rankByAttention / topPriorities — severity ranking reuses Decision.riskLevel/confidence verbatim", () => {
  it("A: critical outranks high outranks medium outranks low outranks info, regardless of input order", () => {
    const decisions = [
      decision({ key: "a", riskLevel: "low", confidence: 0.9 }),
      decision({ key: "b", riskLevel: "critical", confidence: 0.1 }),
      decision({ key: "c", riskLevel: "medium", confidence: 0.5 }),
      decision({ key: "d", riskLevel: "info", confidence: 0.99 }),
      decision({ key: "e", riskLevel: "high", confidence: 0.5 }),
    ];
    const ranked = rankByAttention(decisions);
    expect(ranked.map((d) => d.key)).toEqual(["b", "e", "c", "a", "d"]);
  });

  it("B: within the same riskLevel, higher confidence ranks first — confidence is the only tiebreaker, never invented", () => {
    const decisions = [
      decision({ key: "low-conf", riskLevel: "high", confidence: 0.3 }),
      decision({ key: "high-conf", riskLevel: "high", confidence: 0.9 }),
    ];
    expect(rankByAttention(decisions).map((d) => d.key)).toEqual(["high-conf", "low-conf"]);
  });

  it("C: topPriorities copies WHAT/WHY/EVIDENCE/IMPACT/NEXT-STEP verbatim from the Decision — never generates new text", () => {
    const d = decision({
      key: "k1",
      title: "Beef replenishment",
      trigger: "Beef stock projected below 1 day of cover",
      riskLevel: "critical",
    });
    const [p] = topPriorities([d], 5);
    expect(p.what).toBe(d.trigger);
    expect(p.why).toBe(d.reasoning.whyItMatters);
    expect(p.evidence).toEqual(d.evidence);
    expect(p.impact).toBe(d.reasoning.whatIsLikely);
    expect(p.recommendedNextStep).toBe(d.reasoning.whatHappensNext[0]);
  });

  it("D: hasExistingAction is true only when the decision already carries an action — I14 must never re-recommend in-flight work as new (spec 30/31)", () => {
    const withAction = decision({
      key: "has-action",
      action: {
        id: "a1",
        status: "executed",
        failureReason: null,
        verified: true,
        verificationOutcome: "ok",
      },
    });
    const withoutAction = decision({ key: "no-action", action: null });
    const [p1] = topPriorities([withAction], 5);
    const [p2] = topPriorities([withoutAction], 5);
    expect(p1.hasExistingAction).toBe(true);
    expect(p2.hasExistingAction).toBe(false);
  });

  it("E: limit truncates to the requested count after ranking, not before", () => {
    const decisions = Array.from({ length: 8 }, (_, i) =>
      decision({ key: `d${i}`, riskLevel: i === 0 ? "critical" : "low", confidence: 0.5 }),
    );
    const top = topPriorities(decisions, 3);
    expect(top).toHaveLength(3);
    expect(top[0].key).toBe("d0"); // the one critical item always survives truncation
  });
});

describe("detectMaterialChanges — only fires above the documented threshold, only on fields the engines already computed", () => {
  it("F: a menu item's trendPercent below the threshold is not reported", () => {
    const changes = detectMaterialChanges({
      menu: {
        declining: [{ name: "Salad", trendPercent: -MATERIAL_CHANGE_THRESHOLD_PERCENT + 1 }],
      },
    });
    expect(changes).toHaveLength(0);
  });

  it("G: a menu item's trendPercent at or above the threshold is reported as an OBSERVED change, never inferred", () => {
    const changes = detectMaterialChanges({
      menu: { declining: [{ name: "Salad", trendPercent: -20 }] },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("observed");
    expect(changes[0].direction).toBe("down");
    expect(changes[0].changePercent).toBe(-20);
    expect(changes[0].statement).toContain("Salad");
  });

  it("H: wastage, kitchen and purchasing changes are each surfaced independently when they clear the bar", () => {
    const changes = detectMaterialChanges({
      inventory: { wastage: { changePercent: 100 } },
      kitchen: { trendPercent: 25 },
      purchasing: { spendChangePercent: -18 },
    });
    expect(changes.map((c) => c.domain).sort()).toEqual(["inventory", "kitchen", "purchasing"]);
  });

  it("I: results are ranked by magnitude of change, largest first", () => {
    const changes = detectMaterialChanges({
      kitchen: { trendPercent: 16 },
      purchasing: { spendChangePercent: -60 },
    });
    expect(changes[0].domain).toBe("purchasing");
    expect(changes[1].domain).toBe("kitchen");
  });

  it("J: null/undefined fields (data not available) never produce a fabricated change", () => {
    const changes = detectMaterialChanges({
      kitchen: { trendPercent: null },
      purchasing: { spendChangePercent: null },
    });
    expect(changes).toHaveLength(0);
  });
});

describe("correlateFindingsByEntity — links only via a real shared entity id, never a name match, never causal language", () => {
  it("K: two findings of different kinds sharing the same real inventoryItemId are correlated", () => {
    const findings = [
      finding({
        key: "f1",
        kind: "inventory_shortage",
        subject: "Beef",
        facts: { inventoryItemId: "item-1" },
      }),
      finding({
        key: "f2",
        kind: "purchasing_replenishment",
        subject: "Beef",
        facts: { inventoryItemId: "item-1" },
      }),
    ];
    const correlations = correlateFindingsByEntity(findings);
    expect(correlations).toHaveLength(1);
    expect(correlations[0].entityId).toBe("item-1");
    expect(correlations[0].type).toBe("inferred");
    expect(correlations[0].findingKinds.sort()).toEqual([
      "inventory_shortage",
      "purchasing_replenishment",
    ]);
  });

  it("L: correlation language never claims causation — 'coincides with', never 'caused by' / 'because of'", () => {
    const findings = [
      finding({ kind: "inventory_shortage", facts: { inventoryItemId: "item-1" } }),
      finding({ kind: "supplier_risk", facts: { inventoryItemId: "item-1" } }),
    ];
    const [c] = correlateFindingsByEntity(findings);
    expect(c.statement.toLowerCase()).not.toMatch(/caused by|because of|results in/);
    expect(c.statement).toContain("coincides with");
  });

  it("M: two findings of the SAME kind sharing an entity id are never correlated (that's not cross-domain, it's a duplicate)", () => {
    const findings = [
      finding({ key: "f1", kind: "inventory_shortage", facts: { inventoryItemId: "item-1" } }),
      finding({ key: "f2", kind: "inventory_shortage", facts: { inventoryItemId: "item-1" } }),
    ];
    expect(correlateFindingsByEntity(findings)).toHaveLength(0);
  });

  it("N: findings with no shared entity id (or no id at all) are never correlated by name or any other heuristic", () => {
    const findings = [
      finding({ key: "f1", kind: "inventory_shortage", subject: "Beef", facts: {} }),
      finding({ key: "f2", kind: "menu_margin", subject: "Beef Burger", facts: {} }),
    ];
    expect(correlateFindingsByEntity(findings)).toHaveLength(0);
  });

  it("O: menuItemId-linked findings correlate independently of inventoryItemId-linked ones", () => {
    const findings = [
      finding({ key: "f1", kind: "menu_margin", facts: { menuItemId: "menu-1" } }),
      finding({ key: "f2", kind: "kitchen_capacity", facts: { menuItemId: "menu-1" } }),
    ];
    const [c] = correlateFindingsByEntity(findings);
    expect(c.entityLabel).toBe("menu_item");
    expect(c.entityId).toBe("menu-1");
  });

  it("P: evidence array cites the underlying findings' own headlines, never invented text", () => {
    const findings = [
      finding({
        kind: "inventory_shortage",
        headline: "Beef is running low",
        facts: { inventoryItemId: "item-1" },
      }),
      finding({
        kind: "supplier_risk",
        headline: "Beef supplier price rose 12%",
        facts: { inventoryItemId: "item-1" },
      }),
    ];
    const [c] = correlateFindingsByEntity(findings);
    expect(c.evidence).toEqual(["Beef is running low", "Beef supplier price rose 12%"]);
  });
});

describe("contextSectionsForRole / trimContextForRoles — role-aware intelligence fails closed", () => {
  it("Q: owner and general_manager see every section", () => {
    expect(contextSectionsForRole("owner")).toEqual(
      expect.arrayContaining(["sales", "menu", "inventory", "kitchen", "purchasing", "decisions"]),
    );
    expect(contextSectionsForRole("general_manager")).toHaveLength(6);
  });

  it("R: bartender sees only their scoped sections, never full sales/menu financials", () => {
    const sections = contextSectionsForRole("bartender");
    expect(sections).not.toContain("sales");
    expect(sections).not.toContain("menu");
    expect(sections).not.toContain("purchasing");
  });

  it("S: purchasing_officer sees purchasing/inventory but not menu margin or kitchen ops detail", () => {
    const sections = contextSectionsForRole("purchasing_officer");
    expect(sections).toContain("purchasing");
    expect(sections).toContain("inventory");
    expect(sections).not.toContain("menu");
    expect(sections).not.toContain("kitchen");
  });

  it("T: a role with no explicit mapping (e.g. viewer) gets zero sections — fail closed, never fail open", () => {
    expect(contextSectionsForRole("viewer")).toEqual([]);
  });

  it("U: trimContextForRoles actually removes disallowed sections from a real context object", () => {
    const context = {
      sales: { revenueToday: 500 },
      menu: { totals: {} },
      inventory: { runway: [] },
      kitchen: { stations: [] },
      purchasing: { suggestions: [] },
      decisions: { stored: [] },
      generatedAt: "now",
    };
    const trimmed = trimContextForRoles(context, ["bartender"]);
    expect(trimmed.sales).toBeUndefined();
    expect(trimmed.menu).toBeUndefined();
    expect(trimmed.purchasing).toBeUndefined();
    expect(trimmed.inventory).toEqual({ runway: [] });
    expect(trimmed.kitchen).toEqual({ stations: [] });
    expect(trimmed.decisions).toEqual({ stored: [] });
    expect(trimmed.generatedAt).toBe("now"); // non-domain fields are never gated
  });

  it("V: a user holding multiple roles in the same tenant sees the union of what each role permits, never less", () => {
    const context = {
      sales: {},
      menu: {},
      inventory: {},
      kitchen: {},
      purchasing: {},
      decisions: {},
    };
    const trimmed = trimContextForRoles(context, ["bartender", "purchasing_officer"]);
    // bartender alone lacks purchasing; purchasing_officer alone lacks kitchen — union has both.
    expect(trimmed.purchasing).toBeDefined();
    expect(trimmed.kitchen).toBeDefined();
    expect(trimmed.sales).toBeUndefined(); // neither role grants sales
  });
});
