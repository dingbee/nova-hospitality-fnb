import { describe, expect, it } from "vitest";
import { createP05FakeSupabase, OWNER, OWNER_MEMBER, TENANT_A, TENANT_B } from "./p05.test-helpers";
import { getInventoryMenuOpportunities } from "./inventory-menu.server";

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

function invItem(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_A,
    name: `Item ${id}`,
    current_quantity: 10,
    par_level: 5,
    reorder_point: 2,
    average_cost: 5,
    currency: "TZS",
    status: "active",
    location_id: null,
    ...extra,
  };
}

function order(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_A,
    location_id: null,
    ...extra,
  };
}

function orderItem(orderId: string, menuItemId: string, extra: Record<string, unknown> = {}) {
  return {
    order_id: orderId,
    tenant_id: TENANT_A,
    menu_item_id: menuItemId,
    quantity: 5,
    line_total: 100,
    line_cost: 80, // 20% margin — below the 55% threshold, should surface as a margin opportunity
    status: "served",
    created_at: iso(1),
    ...extra,
  };
}

function menuItem(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_A,
    name: `Menu ${id}`,
    price: 20,
    currency: "TZS",
    lifecycle_status: "active",
    ...extra,
  };
}

describe("getInventoryMenuOpportunities — correctness", () => {
  it("flags a low-margin, well-selling menu item as a margin opportunity", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [],
      restaurant_inventory_batches: [],
      restaurant_stock_movements: [],
      restaurant_menu_items: [menuItem("mi1")],
      restaurant_orders: [order("o1")],
      restaurant_order_items: [orderItem("o1", "mi1")],
      restaurant_recipes: [],
      restaurant_recipe_lines: [],
    });
    const result = await getInventoryMenuOpportunities(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      targetCoverDays: 7,
    });
    expect(result.opportunities.some((o) => o.key === "opportunity.margin.mi1")).toBe(true);
  });
});

describe("getInventoryMenuOpportunities — tenant isolation", () => {
  it("never mixes another tenant's inventory or sales into opportunities", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [invItem("a-item"), invItem("b-item", { tenant_id: TENANT_B })],
      restaurant_inventory_batches: [],
      restaurant_stock_movements: [],
      restaurant_menu_items: [menuItem("mi1"), menuItem("b-mi", { tenant_id: TENANT_B })],
      restaurant_orders: [order("o1"), order("b-o1", { tenant_id: TENANT_B })],
      restaurant_order_items: [
        orderItem("o1", "mi1"),
        orderItem("b-o1", "b-mi", { tenant_id: TENANT_B }),
      ],
      restaurant_recipes: [],
      restaurant_recipe_lines: [],
    });
    const result = await getInventoryMenuOpportunities(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      targetCoverDays: 7,
    });
    expect(result.opportunities.some((o) => o.key === "opportunity.margin.b-mi")).toBe(false);
    expect(result.opportunities.every((o) => o.entityId !== "b-item")).toBe(true);
  });

  it("rejects a caller with no membership in the tenant", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [],
      restaurant_inventory_items: [],
      restaurant_inventory_batches: [],
      restaurant_stock_movements: [],
      restaurant_menu_items: [],
      restaurant_orders: [],
      restaurant_order_items: [],
      restaurant_recipes: [],
      restaurant_recipe_lines: [],
    });
    await expect(
      getInventoryMenuOpportunities(sb, OWNER, {
        tenantId: TENANT_A,
        windowDays: 7,
        targetCoverDays: 7,
      }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });
});

describe("getInventoryMenuOpportunities — outlet/location isolation", () => {
  it("excludes another location's inventory from opportunity detection", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER], // tenant-wide grant — legitimately sees every location
      restaurant_inventory_items: [
        invItem("a-item", { location_id: "loc-a", current_quantity: 1, reorder_point: 5 }),
        invItem("b-item", { location_id: "loc-b", current_quantity: 1, reorder_point: 5 }),
      ],
      restaurant_inventory_batches: [],
      restaurant_stock_movements: [],
      restaurant_menu_items: [],
      restaurant_orders: [],
      restaurant_order_items: [],
      restaurant_recipes: [],
      restaurant_recipe_lines: [],
    });
    const result = await getInventoryMenuOpportunities(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      targetCoverDays: 7,
      locationId: "loc-a",
    });
    expect(result.opportunities.every((o) => o.entityId !== "b-item")).toBe(true);
  });

  it("excludes another location's sales from margin-opportunity detection", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [],
      restaurant_inventory_batches: [],
      restaurant_stock_movements: [],
      restaurant_menu_items: [menuItem("mi1")],
      restaurant_orders: [
        order("o-a", { location_id: "loc-a" }),
        order("o-b", { location_id: "loc-b" }),
      ],
      // The only sale for mi1 happened at loc-b — a loc-a-scoped read must not see it.
      restaurant_order_items: [orderItem("o-b", "mi1")],
      restaurant_recipes: [],
      restaurant_recipe_lines: [],
    });
    const result = await getInventoryMenuOpportunities(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      targetCoverDays: 7,
      locationId: "loc-a",
    });
    expect(result.opportunities.some((o) => o.key === "opportunity.margin.mi1")).toBe(false);
  });

  it("still surfaces the margin opportunity when the sale is at the requested location", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [],
      restaurant_inventory_batches: [],
      restaurant_stock_movements: [],
      restaurant_menu_items: [menuItem("mi1")],
      restaurant_orders: [
        order("o-a", { location_id: "loc-a" }),
        order("o-b", { location_id: "loc-b" }),
      ],
      restaurant_order_items: [orderItem("o-a", "mi1")],
      restaurant_recipes: [],
      restaurant_recipe_lines: [],
    });
    const result = await getInventoryMenuOpportunities(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      targetCoverDays: 7,
      locationId: "loc-a",
    });
    expect(result.opportunities.some((o) => o.key === "opportunity.margin.mi1")).toBe(true);
  });

  it("rejects a caller whose property grant does not cover the requested location", async () => {
    const scopedMember = {
      tenant_id: TENANT_A,
      user_id: OWNER,
      role: "owner",
      property_id: "prop-1",
    };
    const sb = createP05FakeSupabase({
      restaurant_members: [scopedMember],
      restaurant_locations: [{ id: "loc-forged", tenant_id: TENANT_A, property_id: "prop-forged" }],
      restaurant_inventory_items: [],
      restaurant_inventory_batches: [],
      restaurant_stock_movements: [],
      restaurant_menu_items: [],
      restaurant_orders: [],
      restaurant_order_items: [],
      restaurant_recipes: [],
      restaurant_recipe_lines: [],
    });
    await expect(
      getInventoryMenuOpportunities(sb, OWNER, {
        tenantId: TENANT_A,
        windowDays: 7,
        targetCoverDays: 7,
        locationId: "loc-forged",
      }),
    ).rejects.toThrow(/do not have access to this location/);
  });
});
