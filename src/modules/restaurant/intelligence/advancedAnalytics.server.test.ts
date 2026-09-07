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
const getPurchasingIntelligenceMock = vi.fn();
vi.mock("./purchasing.server", () => ({
  getPurchasingIntelligence: (...args: unknown[]) => getPurchasingIntelligenceMock(...args),
}));

const { getAdvancedAnalyticsIntelligence } = await import("./advancedAnalytics.server");

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
const EMPTY_PURCHASING = {
  currency: "TZS",
  suggestions: [],
  suppliers: [],
  expectedMonthlySpend: 0,
  previousMonthlySpend: 0,
  spendChangePercent: null,
  insights: [],
};

beforeEach(() => {
  assertEntitledMock.mockReset();
  assertEntitledMock.mockResolvedValue({ state: "advanced" });
  getMenuIntelligenceMock.mockReset();
  getInventoryIntelligenceMock.mockReset();
  getPurchasingIntelligenceMock.mockReset();
  getMenuIntelligenceMock.mockResolvedValue(EMPTY_MENU);
  getInventoryIntelligenceMock.mockResolvedValue(EMPTY_INVENTORY);
  getPurchasingIntelligenceMock.mockResolvedValue(EMPTY_PURCHASING);
});

describe("getAdvancedAnalyticsIntelligence — correlations", () => {
  it("surfaces a high-sales-low-margin correlation from menu.server.ts's plough_horse quadrant", async () => {
    getMenuIntelligenceMock.mockResolvedValue({
      ...EMPTY_MENU,
      totals: { revenue: 10000, cost: 8000, grossProfit: 2000, itemsSold: 50 },
      items: [
        {
          menuItemId: "item-1",
          name: "Burger",
          quantitySold: 50,
          revenue: 10000,
          grossProfit: 2000,
          marginPercent: 5,
          classification: "plough_horse",
        },
      ],
    });
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    const result = await getAdvancedAnalyticsIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.correlations.some((c) => c.kind === "high_sales_low_margin")).toBe(true);
  });

  it("surfaces slow-moving stock from runway rows with negligible velocity", async () => {
    getInventoryIntelligenceMock.mockResolvedValue({
      ...EMPTY_INVENTORY,
      runway: [
        {
          inventoryItemId: "inv-1",
          name: "Truffle oil",
          currentQuantity: 40,
          dailyVelocity: 0.01,
          daysOfCover: 4000,
          reorderPoint: 5,
          belowReorder: false,
        },
      ],
    });
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    const result = await getAdvancedAnalyticsIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.correlations.some((c) => c.kind === "slow_moving_stock")).toBe(true);
  });

  it("every correlation carries non-empty evidence", async () => {
    getMenuIntelligenceMock.mockResolvedValue({
      ...EMPTY_MENU,
      totals: { revenue: 10000, cost: 8000, grossProfit: 2000, itemsSold: 50 },
      items: [
        {
          menuItemId: "item-1",
          name: "Burger",
          quantitySold: 50,
          revenue: 10000,
          grossProfit: 2000,
          marginPercent: 5,
          classification: "plough_horse",
        },
      ],
      profitDrivers: [
        {
          menuItemId: "item-2",
          name: "Steak",
          quantitySold: 20,
          revenue: 8000,
          grossProfit: 4000,
          marginPercent: 50,
        },
      ],
    });
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    const result = await getAdvancedAnalyticsIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    for (const c of result.correlations) expect(c.evidence.length).toBeGreaterThan(0);
  });

  it("returns an empty correlation list rather than fabricating one when there is nothing to cross-reference", async () => {
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    const result = await getAdvancedAnalyticsIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.correlations).toEqual([]);
  });
});

describe("getAdvancedAnalyticsIntelligence — entitlement", () => {
  it("denies a caller not entitled to advanced_analytics", async () => {
    const { CommercialEntitlementError } = await import("@/modules/commercial/resolver.server");
    assertEntitledMock.mockRejectedValue(
      new (CommercialEntitlementError as any)("advanced_analytics", "unavailable"),
    );
    const sb = createP05FakeSupabase({ restaurant_members: [OWNER_MEMBER] });
    await expect(
      getAdvancedAnalyticsIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 }),
    ).rejects.toThrow(/not entitled/);
  });
});
