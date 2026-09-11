/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
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

const { getRevenueIntelligence } = await import("./revenue.server");

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

function order(daysAgo: number, total: number, extra: Record<string, unknown> = {}) {
  return {
    id: `order-${Math.random()}`,
    tenant_id: TENANT_A,
    location_id: "loc-1",
    service_period_id: "period-lunch",
    opened_at: iso(daysAgo),
    total,
    payment_state: "paid",
    currency: "TZS",
    status: "closed",
    ...extra,
  };
}

beforeEach(() => {
  assertEntitledMock.mockReset();
  assertEntitledMock.mockResolvedValue({ state: "advanced" });
});

describe("getRevenueIntelligence — correctness", () => {
  it("sums revenue from closed, non-refunded orders and excludes refunded ones", async () => {
    const orders = [
      order(1, 10000, { id: "o1" }),
      order(2, 5000, { id: "o2" }),
      order(1, 99999, { id: "o-refunded", payment_state: "refunded" }),
      order(1, 99999, { id: "o-open", status: "open" }),
    ];
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: orders,
      restaurant_locations: [{ id: "loc-1", tenant_id: TENANT_A, name: "Main" }],
      restaurant_service_periods: [{ id: "period-lunch", tenant_id: TENANT_A, name: "Lunch" }],
      restaurant_order_items: [],
      restaurant_profitability_snapshots: [],
    });

    const result = await getRevenueIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(result.totalRevenue).toBe(15000);
    expect(result.totalOrders).toBe(2);
    expect(result.averageOrderValue).toBe(7500);
  });

  it("reads margin from profitability snapshots verbatim and marks it unavailable when absent", async () => {
    const orders = [order(1, 10000, { id: "o1" })];
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: orders,
      restaurant_locations: [],
      restaurant_service_periods: [],
      restaurant_order_items: [
        {
          order_id: "o1",
          tenant_id: TENANT_A,
          menu_item_id: "item-1",
          description: "Pizza",
          quantity: 2,
          line_total: 10000,
          status: "served",
        },
      ],
      restaurant_profitability_snapshots: [
        {
          tenant_id: TENANT_A,
          menu_item_id: "item-1",
          margin_percent: 42,
          period_start: "2020-01-01",
          period_end: "2099-01-01",
        },
      ],
    });

    const result = await getRevenueIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(result.marginDataAvailable).toBe(true);
    expect(result.topContributors[0]?.marginPercent).toBe(42);
    expect(result.topContributors[0]?.marginSource).toBe("profitability_snapshot");
  });

  it("marks margin unavailable (never estimated) when no snapshot covers the item", async () => {
    const orders = [
      order(1, 10000, { id: "o1" }),
      order(2, 1000, { id: "o2" }),
      order(3, 1000, { id: "o3" }),
      order(4, 1000, { id: "o4" }),
      order(5, 1000, { id: "o5" }),
    ];
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: orders,
      restaurant_locations: [],
      restaurant_service_periods: [],
      restaurant_order_items: [
        {
          order_id: "o1",
          tenant_id: TENANT_A,
          menu_item_id: "item-1",
          description: "Pizza",
          quantity: 2,
          line_total: 10000,
          status: "served",
        },
      ],
      restaurant_profitability_snapshots: [],
    });

    const result = await getRevenueIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(result.marginDataAvailable).toBe(false);
    expect(result.topContributors[0]?.marginPercent).toBeNull();
    expect(result.topContributors[0]?.marginSource).toBe("unavailable");
    expect(result.insights.some((i) => i.key === "revenue.margin_unavailable")).toBe(true);
  });

  it("P07: sales composition decomposes gross/discount/tax/service-charge/cash-collected independently of totalRevenue", async () => {
    const orders = [
      order(1, 11500, {
        id: "o1",
        subtotal: 12000,
        discount_total: 1000,
        tax_total: 400,
        service_charge: 100,
        paid_total: 11500,
      }),
      order(2, 5750, {
        id: "o2",
        subtotal: 6000,
        discount_total: 500,
        tax_total: 200,
        service_charge: 50,
        paid_total: 3000, // partially paid — must surface as outstanding, not hidden inside "revenue"
      }),
    ];
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: orders,
      restaurant_locations: [],
      restaurant_service_periods: [],
      restaurant_order_items: [],
      restaurant_profitability_snapshots: [],
    });
    const result = await getRevenueIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(result.totalRevenue).toBe(17250); // 11500 + 5750 — unaffected by the new fields
    expect(result.salesComposition).toEqual({
      grossSales: 18000,
      discountTotal: 1500,
      taxTotal: 600,
      serviceChargeTotal: 150,
      netSales: 17250,
      cashCollected: 14500,
      outstandingAmount: 2750,
    });
    // The accounting identity the whole point of this block rests on.
    const c = result.salesComposition;
    expect(
      Number((c.grossSales - c.discountTotal + c.taxTotal + c.serviceChargeTotal).toFixed(2)),
    ).toBe(c.netSales);
  });

  it("flags an outlet materially underperforming the group average", async () => {
    const orders = [
      order(1, 100000, { id: "o1", location_id: "loc-strong" }),
      order(2, 100000, { id: "o2", location_id: "loc-strong" }),
      order(3, 100000, { id: "o3", location_id: "loc-strong" }),
      order(4, 100000, { id: "o4", location_id: "loc-strong" }),
      order(5, 5000, { id: "o5", location_id: "loc-weak" }),
    ];
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: orders,
      restaurant_locations: [
        { id: "loc-strong", tenant_id: TENANT_A, name: "Strong" },
        { id: "loc-weak", tenant_id: TENANT_A, name: "Weak" },
      ],
      restaurant_service_periods: [],
      restaurant_order_items: [],
      restaurant_profitability_snapshots: [],
    });
    const result = await getRevenueIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(result.insights.some((i) => i.key.startsWith("revenue.outlet_underperformance"))).toBe(
      true,
    );
  });
});

describe("getRevenueIntelligence — entitlement & isolation", () => {
  it("denies a caller not entitled to revenue_intelligence", async () => {
    const { CommercialEntitlementError } = await import("@/modules/commercial/resolver.server");
    assertEntitledMock.mockRejectedValue(
      new (CommercialEntitlementError as any)("revenue_intelligence", "unavailable"),
    );
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: [],
      restaurant_locations: [],
      restaurant_service_periods: [],
      restaurant_order_items: [],
      restaurant_profitability_snapshots: [],
    });
    await expect(
      getRevenueIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 }),
    ).rejects.toThrow(/not entitled/);
  });

  it("rejects a forged locationId outside the caller's granted property", async () => {
    const scopedMember = {
      tenant_id: TENANT_A,
      user_id: OWNER,
      role: "owner",
      property_id: "prop-1",
    };
    const sb = createP05FakeSupabase({
      restaurant_members: [scopedMember],
      restaurant_locations: [{ id: "loc-forged", tenant_id: TENANT_A, property_id: "prop-other" }],
      restaurant_orders: [],
      restaurant_service_periods: [],
      restaurant_order_items: [],
      restaurant_profitability_snapshots: [],
    });
    await expect(
      getRevenueIntelligence(sb, OWNER, {
        tenantId: TENANT_A,
        windowDays: 30,
        locationId: "loc-forged",
      }),
    ).rejects.toThrow(/do not have access to this location/);
  });
});
