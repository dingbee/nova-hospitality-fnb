/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createP05FakeSupabase, OWNER, OWNER_MEMBER, TENANT_A, TENANT_B } from "./p05.test-helpers";

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

const { getDemandIntelligence } = await import("./demand.server");

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

function order(daysAgo: number, extra: Record<string, unknown> = {}) {
  return {
    id: `order-${Math.random()}`,
    tenant_id: TENANT_A,
    property_id: null,
    location_id: "loc-1",
    service_period_id: "period-lunch",
    guest_count: 2,
    opened_at: iso(daysAgo),
    currency: "TZS",
    status: "closed",
    ...extra,
  };
}

function orderItem(orderId: string, menuItemId: string, quantity: number, desc = "Burger") {
  return {
    order_id: orderId,
    tenant_id: TENANT_A,
    menu_item_id: menuItemId,
    description: desc,
    quantity,
    status: "served",
  };
}

beforeEach(() => {
  assertEntitledMock.mockReset();
  assertEntitledMock.mockResolvedValue({ state: "advanced" });
});

describe("getDemandIntelligence — correctness", () => {
  it("counts only closed orders and computes order trend vs prior window", async () => {
    const orders = [
      order(1, { id: "o1" }),
      order(2, { id: "o2" }),
      order(3, { id: "o3" }),
      order(35, { id: "o4" }), // prior window
      order(1, { id: "o-cancelled", status: "cancelled" }), // excluded
      order(1, { id: "o-other-tenant", tenant_id: TENANT_B }), // excluded
    ];
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: orders,
      restaurant_order_items: [orderItem("o1", "item-1", 5)],
      restaurant_service_periods: [{ id: "period-lunch", name: "Lunch", tenant_id: TENANT_A }],
    });

    const result = await getDemandIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(result.totalOrders).toBe(3);
    expect(result.previousTotalOrders).toBe(1);
    expect(result.topItems[0]?.quantitySold).toBe(5);
  });

  it("marks emerging/declining items from a >=20% quantity swing vs the prior window", async () => {
    const orders = [order(1, { id: "cur1" }), order(35, { id: "prev1" })];
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: orders,
      restaurant_order_items: [
        orderItem("cur1", "item-hot", 10, "Hot item"),
        orderItem("prev1", "item-hot", 4, "Hot item"),
        orderItem("cur1", "item-cold", 1, "Cold item"),
        orderItem("prev1", "item-cold", 5, "Cold item"),
      ],
      restaurant_service_periods: [],
    });

    const result = await getDemandIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(result.emergingItems.some((i) => i.name === "Hot item")).toBe(true);
    expect(result.decliningItems.some((i) => i.name === "Cold item")).toBe(true);
  });

  it("reports INSUFFICIENT_DATA when order history is thin", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: [order(1)],
      restaurant_order_items: [],
      restaurant_service_periods: [],
    });
    const result = await getDemandIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(["NO_DATA", "INSUFFICIENT_DATA"]).toContain(result.sufficiency);
    expect(result.insights.some((i) => i.key === "demand.insufficient_data")).toBe(true);
  });
});

describe("getDemandIntelligence — entitlement", () => {
  it("denies a caller whose plan is not entitled to demand_intelligence", async () => {
    const { CommercialEntitlementError } = await import("@/modules/commercial/resolver.server");
    assertEntitledMock.mockRejectedValue(
      new (CommercialEntitlementError as any)("demand_intelligence", "unavailable"),
    );
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: [],
      restaurant_order_items: [],
      restaurant_service_periods: [],
    });
    await expect(
      getDemandIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 }),
    ).rejects.toThrow(/not entitled/);
  });

  it("calls assertEntitled with the demand_intelligence capability code", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: [],
      restaurant_order_items: [],
      restaurant_service_periods: [],
    });
    await getDemandIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(assertEntitledMock).toHaveBeenCalledWith(
      sb,
      TENANT_A,
      "demand_intelligence",
      expect.anything(),
    );
  });
});

describe("getDemandIntelligence — security / scope isolation", () => {
  it("rejects a caller with no membership in the tenant", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [], // caller belongs to no tenant
      restaurant_orders: [],
      restaurant_order_items: [],
      restaurant_service_periods: [],
    });
    await expect(
      getDemandIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });

  it("rejects a caller whose property grant does not cover the requested property", async () => {
    const scopedMember = {
      tenant_id: TENANT_A,
      user_id: OWNER,
      role: "owner",
      property_id: "prop-1",
    };
    const sb = createP05FakeSupabase({
      restaurant_members: [scopedMember],
      restaurant_orders: [],
      restaurant_order_items: [],
      restaurant_service_periods: [],
    });
    await expect(
      getDemandIntelligence(sb, OWNER, {
        tenantId: TENANT_A,
        windowDays: 30,
        propertyId: "prop-forged",
      }),
    ).rejects.toThrow(/do not have access to this property/);
  });

  it("never returns another tenant's orders even if IDs collide across tenants", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: [
        order(1, { id: "same-id", tenant_id: TENANT_A }),
        { ...order(1, { id: "same-id" }), tenant_id: TENANT_B },
      ],
      restaurant_order_items: [],
      restaurant_service_periods: [],
    });
    const result = await getDemandIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    expect(result.totalOrders).toBe(1);
  });
});
