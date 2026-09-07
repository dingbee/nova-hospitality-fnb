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

const getPurchasingIntelligenceMock = vi.fn();
vi.mock("./purchasing.server", () => ({
  getPurchasingIntelligence: (...args: unknown[]) => getPurchasingIntelligenceMock(...args),
}));

const { getForecastingIntelligence } = await import("./forecasting.server");

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

beforeEach(() => {
  assertEntitledMock.mockReset();
  assertEntitledMock.mockResolvedValue({ state: "advanced" });
  getPurchasingIntelligenceMock.mockReset();
  getPurchasingIntelligenceMock.mockResolvedValue({
    currency: "TZS",
    windowDays: 30,
    suggestions: [
      {
        inventoryItemId: "item-1",
        name: "Flour",
        recommendedQuantity: 10,
        estimatedCost: 5000,
        leadTimeDays: 2,
        coverDays: 7,
      },
    ],
    suppliers: [],
    expectedMonthlySpend: 0,
    previousMonthlySpend: 0,
    spendChangePercent: null,
    insights: [],
  });
});

describe("getForecastingIntelligence — composition", () => {
  it("is insufficient_data with too little order history", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: [],
    });
    const result = await getForecastingIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
      horizonDays: 14,
    });
    expect(result.salesDemand.method).toBe("insufficient_data");
    expect(result.revenue.method).toBe("insufficient_data");
  });

  it("projects a trend once enough closed-order history exists", async () => {
    const orders = Array.from({ length: 20 }, (_, i) => ({
      id: `o${i}`,
      tenant_id: TENANT_A,
      opened_at: iso(i + 1),
      total: 1000,
      currency: "TZS",
      status: "closed",
      payment_state: "paid",
    }));
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: orders,
    });
    const result = await getForecastingIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
      horizonDays: 14,
    });
    expect(result.salesDemand.method).toBe("linear_trend");
    expect(result.revenue.method).toBe("linear_trend");
  });

  it("reframes purchasing's own suggestions verbatim as the inventory-requirement forecast, without recomputing them", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: [],
    });
    const result = await getForecastingIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
      horizonDays: 14,
    });
    expect(result.inventoryRequirement.items).toEqual([
      {
        inventoryItemId: "item-1",
        name: "Flour",
        recommendedQuantity: 10,
        estimatedCost: 5000,
        leadTimeDays: 2,
        coverDays: 7,
      },
    ]);
  });

  it("denies a caller not entitled to forecasting even if entitled to demand/revenue", async () => {
    const { CommercialEntitlementError } = await import("@/modules/commercial/resolver.server");
    assertEntitledMock.mockImplementation((_sb: any, _tenantId: string, code: string) => {
      if (code === "forecasting")
        throw new (CommercialEntitlementError as any)(code, "unavailable");
      return { state: "advanced" };
    });
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: [],
    });
    await expect(
      getForecastingIntelligence(sb, OWNER, {
        tenantId: TENANT_A,
        windowDays: 30,
        horizonDays: 14,
      }),
    ).rejects.toThrow(/not entitled/);
  });
});
