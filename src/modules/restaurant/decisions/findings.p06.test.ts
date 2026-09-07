/**
 * P06 — demand_shift / revenue_underperformance finding generators.
 *
 * Both are sourced verbatim from already-computed P05 engine output (never
 * recomputed) and are Level 0/informational only — see findings.ts's doc
 * comments for why neither fabricates an action-linked executor.
 */
import { describe, expect, it } from "vitest";
import { demandShiftFindings, revenueUnderperformanceFindings, gatherFindings } from "./findings";
import type {
  DemandIntelligence,
  MultiLocationIntelligence,
  RevenueIntelligence,
} from "../intelligence/p05.types";
import type {
  InventoryIntelligence,
  KitchenIntelligence,
  MenuIntelligence,
  PurchasingIntelligence,
} from "../intelligence/types";

function baseDemand(overrides: Partial<DemandIntelligence> = {}): DemandIntelligence {
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    currency: "TZS",
    sufficiency: "SUFFICIENT_DATA",
    sufficiencyReasons: [],
    totalOrders: 40,
    totalCovers: 80,
    previousTotalOrders: 30,
    orderTrendPercent: 33,
    byDayOfWeek: [],
    byServicePeriod: [],
    topItems: [],
    emergingItems: [],
    decliningItems: [],
    insights: [],
    ...overrides,
  };
}

function baseRevenue(overrides: Partial<RevenueIntelligence> = {}): RevenueIntelligence {
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    currency: "TZS",
    sufficiency: "SUFFICIENT_DATA",
    sufficiencyReasons: [],
    totalRevenue: 500000,
    previousRevenue: 480000,
    revenueTrendPercent: 4,
    totalOrders: 40,
    averageOrderValue: 12500,
    series: [],
    byServicePeriod: [],
    topContributors: [],
    underperformers: [],
    byOutlet: [],
    marginDataAvailable: false,
    anomalies: [],
    insights: [],
    ...overrides,
  };
}

describe("demandShiftFindings", () => {
  it("produces a finding per emerging item, never recomputing the trend", () => {
    const demand = baseDemand({
      emergingItems: [
        {
          menuItemId: "item-1",
          name: "Grilled Prawns",
          quantitySold: 20,
          previousQuantitySold: 8,
          trendPercent: 150,
          trend: "emerging",
        },
      ],
    });
    const findings = demandShiftFindings(demand);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("demand_shift");
    expect(findings[0]!.subject).toBe("Grilled Prawns");
    expect(findings[0]!.severity).toBe("high"); // >=50% trend
    expect(findings[0]!.facts.trendPercent).toBe(150);
  });

  it("returns nothing when sufficiency is too low to trust the trend", () => {
    const demand = baseDemand({
      sufficiency: "INSUFFICIENT_DATA",
      emergingItems: [
        {
          menuItemId: "item-1",
          name: "X",
          quantitySold: 5,
          previousQuantitySold: 1,
          trendPercent: 400,
          trend: "emerging",
        },
      ],
    });
    expect(demandShiftFindings(demand)).toEqual([]);
  });

  it("returns nothing when there is nothing emerging", () => {
    expect(demandShiftFindings(baseDemand())).toEqual([]);
  });
});

describe("revenueUnderperformanceFindings", () => {
  it("promotes a revenue.server.ts outlet-underperformance anomaly verbatim", () => {
    const revenue = baseRevenue({
      anomalies: [
        {
          key: "revenue.outlet_underperformance.loc-weak",
          severity: "medium",
          title: "Weak Outlet is materially underperforming the group average",
          detail: "TZS 5,000 versus a group average of TZS 47,600.",
        },
      ],
    });
    const findings = revenueUnderperformanceFindings(revenue, null);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("revenue_underperformance");
    expect(findings[0]!.headline).toMatch(/materially underperforming/i);
  });

  it("promotes a multiLocation.server.ts underperformer insight verbatim", () => {
    const revenue = baseRevenue();
    const multiLocation: MultiLocationIntelligence = {
      generatedAt: new Date().toISOString(),
      windowDays: 30,
      currency: "TZS",
      locations: [],
      bestPerforming: "loc-a",
      worstPerforming: "loc-b",
      insights: [
        {
          key: "multi_location.underperformer.loc-b",
          severity: "medium",
          title: "Uptown is materially underperforming the group's average",
          detail: "TZS 5,000 versus a group average of TZS 27,500.",
        },
      ],
    };
    const findings = revenueUnderperformanceFindings(revenue, multiLocation);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("revenue_underperformance");
  });

  it("never duplicates when the same signal key appears from both sources", () => {
    const dupeKey = "revenue.outlet_underperformance.loc-weak";
    const revenue = baseRevenue({
      anomalies: [{ key: dupeKey, severity: "medium", title: "T", detail: "D" }],
    });
    const findings = revenueUnderperformanceFindings(revenue, null);
    expect(findings).toHaveLength(1);
  });

  it("returns nothing when nothing is underperforming", () => {
    expect(revenueUnderperformanceFindings(baseRevenue(), null)).toEqual([]);
  });
});

describe("gatherFindings — P06 domains are optional and additive", () => {
  const EMPTY_MENU: MenuIntelligence = {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    currency: "TZS",
    totals: { revenue: 0, cost: 0, grossProfit: 0, itemsSold: 0 },
    items: [],
    profitDrivers: [],
    marginLosers: [],
    declining: [],
    promote: [],
    costReview: [],
    insights: [],
  };
  const EMPTY_INVENTORY: InventoryIntelligence = {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    currency: "TZS",
    runway: [],
    atRisk: [],
    wastage: { currentCost: 0, previousCost: 0, changePercent: null, topItems: [] },
    priceThreats: [],
    insights: [],
  };
  const EMPTY_KITCHEN: KitchenIntelligence = {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    ticketsAnalysed: 0,
    averagePrepMinutes: null,
    previousAveragePrepMinutes: null,
    trendPercent: null,
    stations: [],
    insights: [],
  };
  const EMPTY_PURCHASING: PurchasingIntelligence = {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    currency: "TZS",
    suggestions: [],
    suppliers: [],
    expectedMonthlySpend: 0,
    previousMonthlySpend: 0,
    spendChangePercent: null,
    insights: [],
  };

  it("produces the same findings as before when demand/revenue/multiLocation are omitted (Core tenant)", () => {
    const findings = gatherFindings({
      menu: EMPTY_MENU,
      inventory: EMPTY_INVENTORY,
      kitchen: EMPTY_KITCHEN,
      purchasing: EMPTY_PURCHASING,
    });
    expect(findings).toEqual([]);
  });

  it("layers demand_shift/revenue_underperformance findings on top when P05 data is present (Pro tenant)", () => {
    const findings = gatherFindings({
      menu: EMPTY_MENU,
      inventory: EMPTY_INVENTORY,
      kitchen: EMPTY_KITCHEN,
      purchasing: EMPTY_PURCHASING,
      demand: baseDemand({
        emergingItems: [
          {
            menuItemId: "item-1",
            name: "Y",
            quantitySold: 20,
            previousQuantitySold: 8,
            trendPercent: 150,
            trend: "emerging",
          },
        ],
      }),
      revenue: baseRevenue({
        anomalies: [
          {
            key: "revenue.outlet_underperformance.loc-x",
            severity: "medium",
            title: "T",
            detail: "D",
          },
        ],
      }),
      multiLocation: null,
    });
    expect(findings.some((f) => f.kind === "demand_shift")).toBe(true);
    expect(findings.some((f) => f.kind === "revenue_underperformance")).toBe(true);
  });

  it("treats demand:null exactly like demand omitted — never throws, never fabricates a finding", () => {
    const findings = gatherFindings({
      menu: EMPTY_MENU,
      inventory: EMPTY_INVENTORY,
      kitchen: EMPTY_KITCHEN,
      purchasing: EMPTY_PURCHASING,
      demand: null,
      revenue: null,
      multiLocation: null,
    });
    expect(findings).toEqual([]);
  });
});
