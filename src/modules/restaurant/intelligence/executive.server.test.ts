/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows / mocked engine payloads are untyped at this boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createP05FakeSupabase, OWNER, OWNER_MEMBER, TENANT_A } from "./p05.test-helpers";

const assertEntitledMock = vi.fn();
vi.mock("@/modules/commercial/resolver.server", () => ({
  assertEntitled: (...args: unknown[]) => assertEntitledMock(...args),
  CommercialEntitlementError: class CommercialEntitlementError extends Error {
    constructor(
      public capabilityCode: string,
      public state: string,
    ) {
      super(`Forbidden — "${capabilityCode}" is not entitled (state: ${state}).`);
    }
  },
}));

const getMenuIntelligenceMock = vi.fn();
vi.mock("./menu.server", () => ({
  getMenuIntelligence: (...args: unknown[]) => getMenuIntelligenceMock(...args),
}));
const getInventoryIntelligenceMock = vi.fn();
vi.mock("./inventory.server", () => ({
  getInventoryIntelligence: (...args: unknown[]) => getInventoryIntelligenceMock(...args),
}));
const getDemandIntelligenceMock = vi.fn();
vi.mock("./demand.server", () => ({
  getDemandIntelligence: (...args: unknown[]) => getDemandIntelligenceMock(...args),
}));
const getRevenueIntelligenceMock = vi.fn();
vi.mock("./revenue.server", () => ({
  getRevenueIntelligence: (...args: unknown[]) => getRevenueIntelligenceMock(...args),
}));

const { getExecutiveIntelligence } = await import("./executive.server");

const EMPTY_MENU = {
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
const EMPTY_INVENTORY = {
  currency: "TZS",
  runway: [],
  atRisk: [],
  wastage: { currentCost: 0, previousCost: 0, changePercent: null, topItems: [] },
  priceThreats: [],
  insights: [],
};
const EMPTY_DEMAND = {
  currency: "TZS",
  sufficiency: "SUFFICIENT_DATA",
  sufficiencyReasons: [],
  totalOrders: 0,
  totalCovers: 0,
  previousTotalOrders: 0,
  orderTrendPercent: null,
  byDayOfWeek: [],
  byServicePeriod: [],
  topItems: [],
  emergingItems: [],
  decliningItems: [],
  insights: [],
};
const EMPTY_REVENUE = {
  currency: "TZS",
  sufficiency: "SUFFICIENT_DATA",
  sufficiencyReasons: [],
  totalRevenue: 0,
  previousRevenue: 0,
  revenueTrendPercent: null,
  totalOrders: 0,
  averageOrderValue: 0,
  series: [],
  byServicePeriod: [],
  topContributors: [],
  underperformers: [],
  byOutlet: [],
  marginDataAvailable: false,
  anomalies: [],
  insights: [],
};

beforeEach(() => {
  assertEntitledMock.mockReset();
  assertEntitledMock.mockResolvedValue({ state: "advanced" });
  getMenuIntelligenceMock.mockReset();
  getInventoryIntelligenceMock.mockReset();
  getDemandIntelligenceMock.mockReset();
  getRevenueIntelligenceMock.mockReset();
  getMenuIntelligenceMock.mockResolvedValue(EMPTY_MENU);
  getInventoryIntelligenceMock.mockResolvedValue(EMPTY_INVENTORY);
  getDemandIntelligenceMock.mockResolvedValue(EMPTY_DEMAND);
  getRevenueIntelligenceMock.mockResolvedValue(EMPTY_REVENUE);
});

describe("getExecutiveIntelligence — health scoring", () => {
  it("is 'strong' when no risk signals are present", async () => {
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    const result = await getExecutiveIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.overallHealth).toBe("strong");
  });

  it("worsens health when critical inventory risk is present, and compounds to 'critical' when paired with a sharp revenue decline", async () => {
    getInventoryIntelligenceMock.mockResolvedValue({
      ...EMPTY_INVENTORY,
      atRisk: [
        {
          inventoryItemId: "i1",
          name: "Flour",
          currentQuantity: 1,
          dailyVelocity: 5,
          daysOfCover: 1,
          reorderPoint: 10,
          belowReorder: true,
        },
      ],
    });
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    const soleSignal = await getExecutiveIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(soleSignal.overallHealth).toBe("needs_attention");
    expect(soleSignal.healthReasons.some((r) => r.includes("critical stock risk"))).toBe(true);

    getRevenueIntelligenceMock.mockResolvedValue({
      ...EMPTY_REVENUE,
      revenueTrendPercent: -25,
      totalRevenue: 5000,
    });
    const compounded = await getExecutiveIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(compounded.overallHealth).toBe("critical");
  });

  it("worsens health when revenue is down sharply", async () => {
    getRevenueIntelligenceMock.mockResolvedValue({
      ...EMPTY_REVENUE,
      revenueTrendPercent: -25,
      totalRevenue: 5000,
    });
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    const result = await getExecutiveIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.overallHealth).not.toBe("strong");
    expect(result.revenue.trendPercent).toBe(-25);
  });

  it("surfaces high/critical insights from every domain as significant anomalies", async () => {
    getInventoryIntelligenceMock.mockResolvedValue({
      ...EMPTY_INVENTORY,
      insights: [
        { key: "inv.crit", severity: "critical", title: "Critical shortage", detail: "x" },
      ],
    });
    getRevenueIntelligenceMock.mockResolvedValue({
      ...EMPTY_REVENUE,
      insights: [{ key: "rev.high", severity: "high", title: "Revenue drop", detail: "x" }],
    });
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    const result = await getExecutiveIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.significantAnomalies.map((a) => a.key)).toEqual(
      expect.arrayContaining(["inv.crit", "rev.high"]),
    );
    // Sorted most-severe first.
    expect(result.significantAnomalies[0]?.severity).toBe("critical");
  });
});

describe("getExecutiveIntelligence — entitlement", () => {
  it("denies a caller not entitled to executive_intelligence", async () => {
    const { CommercialEntitlementError } = await import("@/modules/commercial/resolver.server");
    assertEntitledMock.mockRejectedValue(
      new (CommercialEntitlementError as any)("executive_intelligence", "unavailable"),
    );
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    await expect(
      getExecutiveIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 }),
    ).rejects.toThrow(/not entitled/);
  });
});
