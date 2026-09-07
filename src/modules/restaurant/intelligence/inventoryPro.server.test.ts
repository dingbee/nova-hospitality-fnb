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

const getInventoryIntelligenceMock = vi.fn();
vi.mock("./inventory.server", () => ({
  getInventoryIntelligence: (...args: unknown[]) => getInventoryIntelligenceMock(...args),
}));
const getPurchasingIntelligenceMock = vi.fn();
vi.mock("./purchasing.server", () => ({
  getPurchasingIntelligence: (...args: unknown[]) => getPurchasingIntelligenceMock(...args),
}));

const { getInventoryIntelligencePro } = await import("./inventoryPro.server");

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

beforeEach(() => {
  assertEntitledMock.mockReset();
  assertEntitledMock.mockResolvedValue({ state: "advanced" });
  getInventoryIntelligenceMock.mockReset();
  getPurchasingIntelligenceMock.mockReset();
  getInventoryIntelligenceMock.mockResolvedValue({
    currency: "TZS",
    runway: [
      {
        inventoryItemId: "item-spike",
        name: "Chicken",
        currentQuantity: 20,
        dailyVelocity: 10,
        daysOfCover: 2,
        reorderPoint: 15,
        belowReorder: true,
      },
    ],
    atRisk: [
      {
        inventoryItemId: "item-spike",
        name: "Chicken",
        currentQuantity: 20,
        dailyVelocity: 10,
        daysOfCover: 2,
        reorderPoint: 15,
        belowReorder: true,
      },
    ],
    wastage: { currentCost: 0, previousCost: 0, changePercent: null, topItems: [] },
    priceThreats: [],
    insights: [],
  });
  getPurchasingIntelligenceMock.mockResolvedValue({
    currency: "TZS",
    suggestions: [
      {
        inventoryItemId: "item-spike",
        name: "Chicken",
        currentQuantity: 20,
        dailyVelocity: 10,
        leadTimeDays: 2,
        coverDays: 7,
        recommendedQuantity: 50,
        estimatedCost: 100000,
        supplierName: "ACME",
        supplierId: "sup-1",
      },
    ],
    suppliers: [],
    expectedMonthlySpend: 0,
    previousMonthlySpend: 0,
    spendChangePercent: null,
    insights: [],
  });
});

describe("getInventoryIntelligencePro — correctness", () => {
  it("flags a consumption anomaly when current velocity deviates sharply from the prior window", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_stock_movements: [
        // Prior-window consumption: much lower than the current velocity (10/day) reported by the mocked engine.
        {
          inventory_item_id: "item-spike",
          tenant_id: TENANT_A,
          movement_type: "consumption",
          quantity: 30,
          occurred_at: iso(45),
        },
      ],
    });
    const result = await getInventoryIntelligencePro(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(
      result.anomalies.some((a) => a.inventoryItemId === "item-spike" && a.direction === "spike"),
    ).toBe(true);
  });

  it("carries the recommended reorder quantity from purchasing.server.ts verbatim, never recomputed", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_stock_movements: [],
    });
    const result = await getInventoryIntelligencePro(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    const req = result.reorderRequirements.find((r) => r.inventoryItemId === "item-spike");
    expect(req?.recommendedQuantity).toBe(50);
    expect(req?.estimatedCost).toBe(100000);
    expect(req?.supplierName).toBe("ACME");
  });

  it("does not flag an anomaly for a stable, unchanged velocity", async () => {
    getInventoryIntelligenceMock.mockResolvedValue({
      currency: "TZS",
      runway: [
        {
          inventoryItemId: "item-stable",
          name: "Rice",
          currentQuantity: 100,
          dailyVelocity: 5,
          daysOfCover: 20,
          reorderPoint: 10,
          belowReorder: false,
        },
      ],
      atRisk: [],
      wastage: { currentCost: 0, previousCost: 0, changePercent: null, topItems: [] },
      priceThreats: [],
      insights: [],
    });
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_stock_movements: [
        {
          inventory_item_id: "item-stable",
          tenant_id: TENANT_A,
          movement_type: "consumption",
          quantity: 150,
          occurred_at: iso(45),
        }, // ~5/day, same rate
      ],
    });
    const result = await getInventoryIntelligencePro(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.anomalies.some((a) => a.inventoryItemId === "item-stable")).toBe(false);
  });
});

describe("getInventoryIntelligencePro — entitlement", () => {
  it("denies a caller not entitled to inventory_intelligence, even though the free baseline stays open", async () => {
    const { CommercialEntitlementError } = await import("@/modules/commercial/resolver.server");
    assertEntitledMock.mockRejectedValue(
      new (CommercialEntitlementError as any)("inventory_intelligence", "unavailable"),
    );
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_stock_movements: [],
    });
    await expect(
      getInventoryIntelligencePro(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 }),
    ).rejects.toThrow(/not entitled/);
    // The underlying free engine is never even reached once entitlement fails closed.
    expect(getInventoryIntelligenceMock).not.toHaveBeenCalled();
  });
});
