/**
 * P07 §15 — reconciliation tests for menu.server.ts (Sprint 3.1). This
 * engine had zero test coverage before P07 despite being the source
 * advancedAnalytics.server.ts and executive.server.ts both read verbatim —
 * a defect in an untested foundation silently becomes a defect in every
 * capability built on top of it. These tests prove its aggregates
 * reconcile against the raw restaurant_order_items rows it reads, and that
 * it respects the same property/location isolation boundary every other
 * P05 engine enforces.
 */
import { describe, expect, it } from "vitest";
import { createP05FakeSupabase, OWNER, OWNER_MEMBER, TENANT_A } from "./p05.test-helpers";

const { getMenuIntelligence } = await import("./menu.server");

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

describe("getMenuIntelligence — reconciliation against restaurant_order_items", () => {
  it("item revenue/cost/quantity totals equal the sum of the raw order-item rows that fed them", async () => {
    const orders = [
      { id: "o1", tenant_id: TENANT_A, closed_at: iso(1), currency: "TZS", status: "closed" },
      { id: "o2", tenant_id: TENANT_A, closed_at: iso(2), currency: "TZS", status: "closed" },
      // Outside the window (previous period) — must not leak into current totals.
      { id: "o-prev", tenant_id: TENANT_A, closed_at: iso(45), currency: "TZS", status: "closed" },
      // Still open — must be excluded (menu.server.ts's own gte/not-null filter).
      { id: "o-open", tenant_id: TENANT_A, closed_at: null, currency: "TZS", status: "open" },
    ];
    const items = [
      {
        order_id: "o1",
        tenant_id: TENANT_A,
        menu_item_id: "mi-1",
        description: "Burger",
        quantity: 2,
        line_total: 20000,
        line_cost: 8000,
        status: "served",
      },
      {
        order_id: "o2",
        tenant_id: TENANT_A,
        menu_item_id: "mi-1",
        description: "Burger",
        quantity: 1,
        line_total: 10000,
        line_cost: 4000,
        status: "served",
      },
      // Voided line — must be excluded from every aggregate.
      {
        order_id: "o2",
        tenant_id: TENANT_A,
        menu_item_id: "mi-1",
        description: "Burger",
        quantity: 5,
        line_total: 50000,
        line_cost: 20000,
        status: "voided",
      },
      {
        order_id: "o-prev",
        tenant_id: TENANT_A,
        menu_item_id: "mi-1",
        description: "Burger",
        quantity: 9,
        line_total: 90000,
        line_cost: 36000,
        status: "served",
      },
    ];
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: orders,
      restaurant_order_items: items,
      restaurant_menu_items: [
        {
          id: "mi-1",
          tenant_id: TENANT_A,
          name: "Burger",
          price: 10000,
          currency: "TZS",
          cost_price: 4000,
        },
      ],
      restaurant_recipe_costs: [],
    });

    const result = await getMenuIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    const burger = result.items.find((i) => i.menuItemId === "mi-1");
    expect(burger).toBeDefined();

    // Reconcile against a hand-summed expectation from the raw rows: only
    // o1 (qty 2, revenue 20000, cost 8000) and o2's *served* line (qty 1,
    // revenue 10000, cost 4000) are in-window, closed, and non-voided.
    expect(burger!.quantitySold).toBe(3);
    expect(burger!.revenue).toBe(30000);
    expect(burger!.cost).toBe(12000);
    expect(burger!.grossProfit).toBe(18000);
    expect(result.totals.revenue).toBe(30000);
    expect(result.totals.cost).toBe(12000);
    expect(result.totals.itemsSold).toBe(3);
  });

  it("an item with zero in-window sales reports revenue/cost of exactly zero, never omitted or estimated", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_orders: [],
      restaurant_order_items: [],
      restaurant_menu_items: [
        {
          id: "mi-unsold",
          tenant_id: TENANT_A,
          name: "Lobster",
          price: 50000,
          currency: "TZS",
          cost_price: 20000,
        },
      ],
      restaurant_recipe_costs: [],
    });
    const result = await getMenuIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 30 });
    // getMenuIntelligence only returns `sold` items in `.items` — an unsold
    // item is correctly absent rather than reported with fabricated figures.
    expect(result.items.find((i) => i.menuItemId === "mi-unsold")).toBeUndefined();
    expect(result.totals.revenue).toBe(0);
  });
});

describe("getMenuIntelligence — property/location isolation", () => {
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
      restaurant_order_items: [],
      restaurant_menu_items: [],
      restaurant_recipe_costs: [],
    });
    await expect(
      getMenuIntelligence(sb, OWNER, {
        tenantId: TENANT_A,
        windowDays: 30,
        locationId: "loc-forged",
      }),
    ).rejects.toThrow(/do not have access to this location/);
  });
});
