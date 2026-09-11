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

const { getMultiLocationIntelligence } = await import("./multiLocation.server");

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

beforeEach(() => {
  assertEntitledMock.mockReset();
  assertEntitledMock.mockResolvedValue({ state: "advanced" });
  getInventoryIntelligenceMock.mockReset();
  getInventoryIntelligenceMock.mockResolvedValue({
    currency: "TZS",
    runway: [],
    atRisk: [],
    wastage: { currentCost: 0, previousCost: 0, changePercent: null, topItems: [] },
    priceThreats: [],
    insights: [],
  });
});

describe("getMultiLocationIntelligence — correctness", () => {
  it("aggregates revenue/orders per accessible location and ranks best/worst", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_locations: [
        { id: "loc-a", tenant_id: TENANT_A, name: "Downtown", property_id: null },
        { id: "loc-b", tenant_id: TENANT_A, name: "Uptown", property_id: null },
      ],
      restaurant_orders: [
        {
          id: "o1",
          tenant_id: TENANT_A,
          location_id: "loc-a",
          total: 50000,
          currency: "TZS",
          status: "closed",
          payment_state: "paid",
          opened_at: iso(1),
        },
        {
          id: "o2",
          tenant_id: TENANT_A,
          location_id: "loc-b",
          total: 5000,
          currency: "TZS",
          status: "closed",
          payment_state: "paid",
          opened_at: iso(1),
        },
      ],
    });
    const result = await getMultiLocationIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.locations).toHaveLength(2);
    expect(result.bestPerforming).toBe("loc-a");
    expect(result.worstPerforming).toBe("loc-b");
    expect(result.insights.some((i) => i.key.startsWith("multi_location.underperformer"))).toBe(
      true,
    );
  });

  it("returns an empty comparison rather than fabricating one when no locations are accessible", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_locations: [],
      restaurant_orders: [],
    });
    const result = await getMultiLocationIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.locations).toEqual([]);
  });
});

describe("getMultiLocationIntelligence — P09 property rollups", () => {
  it("groups outlet summaries into property rollups, correctly attributing revenue by property", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_properties: [
        { id: "prop-a", tenant_id: TENANT_A, name: "Kilimanjaro Grill" },
        { id: "prop-b", tenant_id: TENANT_A, name: "Serengeti Bistro" },
      ],
      restaurant_locations: [
        { id: "loc-a1", tenant_id: TENANT_A, name: "Grill West", property_id: "prop-a" },
        { id: "loc-a2", tenant_id: TENANT_A, name: "Grill East", property_id: "prop-a" },
        { id: "loc-b1", tenant_id: TENANT_A, name: "Bistro Main", property_id: "prop-b" },
      ],
      restaurant_orders: [
        {
          id: "o1",
          tenant_id: TENANT_A,
          location_id: "loc-a1",
          total: 30000,
          currency: "TZS",
          status: "closed",
          payment_state: "paid",
          opened_at: iso(1),
        },
        {
          id: "o2",
          tenant_id: TENANT_A,
          location_id: "loc-a2",
          total: 20000,
          currency: "TZS",
          status: "closed",
          payment_state: "paid",
          opened_at: iso(1),
        },
        {
          id: "o3",
          tenant_id: TENANT_A,
          location_id: "loc-b1",
          total: 5000,
          currency: "TZS",
          status: "closed",
          payment_state: "paid",
          opened_at: iso(1),
        },
      ],
    });
    const result = await getMultiLocationIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.propertyRollups).toEqual([
      {
        propertyId: "prop-a",
        name: "Kilimanjaro Grill",
        revenue: 50000,
        orders: 2,
        atRiskInventoryCount: 0,
        outletCount: 2,
      },
      {
        propertyId: "prop-b",
        name: "Serengeti Bistro",
        revenue: 5000,
        orders: 1,
        atRiskInventoryCount: 0,
        outletCount: 1,
      },
    ]);
    expect(result.bestPerformingProperty).toBe("prop-a");
    expect(result.worstPerformingProperty).toBe("prop-b");
    expect(
      result.insights.some((i) => i.key.startsWith("multi_location.property_underperformance")),
    ).toBe(true);
  });

  it("returns an empty property rollup for a single-property tenant rather than a fabricated one-item list", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_locations: [
        { id: "loc-a", tenant_id: TENANT_A, name: "Downtown", property_id: "prop-only" },
        { id: "loc-b", tenant_id: TENANT_A, name: "Uptown", property_id: "prop-only" },
      ],
      restaurant_orders: [],
    });
    const result = await getMultiLocationIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.propertyRollups).toEqual([]);
    expect(result.bestPerformingProperty).toBeNull();
  });
});

describe("getMultiLocationIntelligence — entitlement & isolation", () => {
  it("hard-denies a caller not entitled to multi_location_command (no narrowed fallback)", async () => {
    const { CommercialEntitlementError } = await import("@/modules/commercial/resolver.server");
    assertEntitledMock.mockRejectedValue(
      new (CommercialEntitlementError as any)("multi_location_command", "unavailable"),
    );
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_locations: [
        { id: "loc-a", tenant_id: TENANT_A, name: "Downtown", property_id: null },
      ],
      restaurant_orders: [],
    });
    await expect(
      getMultiLocationIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 }),
    ).rejects.toThrow(/not entitled/);
  });

  it("only shows locations under a property-scoped caller's own granted property", async () => {
    const scopedMember = {
      tenant_id: TENANT_A,
      user_id: OWNER,
      role: "owner",
      property_id: "prop-mine",
    };
    const sb = createP05FakeSupabase({
      restaurant_members: [scopedMember],
      restaurant_locations: [
        { id: "loc-mine", tenant_id: TENANT_A, name: "Mine", property_id: "prop-mine" },
        { id: "loc-other", tenant_id: TENANT_A, name: "Other", property_id: "prop-other" },
      ],
      restaurant_orders: [],
    });
    const result = await getMultiLocationIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    expect(result.locations.map((l) => l.locationId)).toEqual(["loc-mine"]);
  });

  it("P09 — a caller scoped to one property never sees another property's rollup, even in aggregate", async () => {
    const scopedMember = {
      tenant_id: TENANT_A,
      user_id: OWNER,
      role: "owner",
      property_id: "prop-mine",
    };
    const sb = createP05FakeSupabase({
      restaurant_members: [scopedMember],
      restaurant_properties: [
        { id: "prop-mine", tenant_id: TENANT_A, name: "Mine" },
        { id: "prop-other", tenant_id: TENANT_A, name: "Other" },
      ],
      restaurant_locations: [
        { id: "loc-mine-1", tenant_id: TENANT_A, name: "Mine 1", property_id: "prop-mine" },
        { id: "loc-mine-2", tenant_id: TENANT_A, name: "Mine 2", property_id: "prop-mine" },
        { id: "loc-other", tenant_id: TENANT_A, name: "Other outlet", property_id: "prop-other" },
      ],
      restaurant_orders: [
        {
          id: "o-other",
          tenant_id: TENANT_A,
          location_id: "loc-other",
          total: 999999,
          currency: "TZS",
          status: "closed",
          payment_state: "paid",
          opened_at: iso(1),
        },
      ],
    });
    const result = await getMultiLocationIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 30,
    });
    // Two accessible outlets, both under prop-mine — a single accessible
    // property produces no rollup at all (nothing to compare), and
    // prop-other's 999999 revenue must never surface anywhere in the result.
    expect(result.propertyRollups).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("prop-other");
    expect(JSON.stringify(result)).not.toContain("999999");
  });
});
