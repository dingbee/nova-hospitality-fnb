import { describe, expect, it } from "vitest";
import { createP05FakeSupabase, OWNER, OWNER_MEMBER, TENANT_A, TENANT_B } from "./p05.test-helpers";
import { getInventoryIntelligence } from "./inventory.server";

const DAY = 864e5;
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

function item(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_A,
    property_id: null,
    location_id: null,
    name: `Item ${id}`,
    current_quantity: 10,
    reorder_point: 5,
    average_cost: 10,
    currency: "TZS",
    status: "active",
    ...extra,
  };
}

function move(itemId: string, daysAgo: number, extra: Record<string, unknown> = {}) {
  return {
    inventory_item_id: itemId,
    tenant_id: TENANT_A,
    property_id: null,
    location_id: null,
    movement_type: "consumption",
    quantity: -3,
    total_cost: 30,
    occurred_at: iso(daysAgo),
    ...extra,
  };
}

describe("getInventoryIntelligence — correctness", () => {
  it("flags items below their reorder point as at-risk", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [item("i1", { current_quantity: 2, reorder_point: 5 })],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    const result = await getInventoryIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 7 });
    expect(result.atRisk.some((r) => r.inventoryItemId === "i1" && r.belowReorder)).toBe(true);
  });

  it("computes days of cover from consumption velocity", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [item("i1", { current_quantity: 21, reorder_point: 0 })],
      restaurant_stock_movements: [move("i1", 0), move("i1", 1), move("i1", 2)],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    const result = await getInventoryIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 3 });
    const row = result.runway.find((r) => r.inventoryItemId === "i1");
    expect(row?.dailyVelocity).toBe(3);
    expect(row?.daysOfCover).toBe(7);
  });
});

describe("getInventoryIntelligence — tenant isolation", () => {
  it("never mixes another tenant's inventory or wastage into the result", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [item("a-item"), item("b-item", { tenant_id: TENANT_B })],
      restaurant_stock_movements: [
        move("a-item", 1),
        move("b-item", 1, { tenant_id: TENANT_B, movement_type: "wastage", total_cost: 99999 }),
      ],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    const result = await getInventoryIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 7 });
    expect(result.runway.every((r) => r.inventoryItemId !== "b-item")).toBe(true);
    expect(result.wastage.currentCost).toBeLessThan(99999);
  });

  it("rejects a caller with no membership in the tenant", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [],
      restaurant_inventory_items: [],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    await expect(
      getInventoryIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 7 }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });
});

describe("getInventoryIntelligence — property isolation", () => {
  it("excludes another property's inventory and movements from a property-scoped read", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER], // tenant-wide grant — legitimately sees every property
      restaurant_inventory_items: [
        item("a-item", { property_id: "prop-a" }),
        item("b-item", { property_id: "prop-b" }),
      ],
      restaurant_stock_movements: [
        move("a-item", 1, { property_id: "prop-a" }),
        move("b-item", 1, { property_id: "prop-b" }),
      ],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    const result = await getInventoryIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      propertyId: "prop-a",
    });
    expect(result.runway.every((r) => r.inventoryItemId !== "b-item")).toBe(true);
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
      restaurant_inventory_items: [],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    await expect(
      getInventoryIntelligence(sb, OWNER, {
        tenantId: TENANT_A,
        windowDays: 7,
        propertyId: "prop-forged",
      }),
    ).rejects.toThrow(/do not have access to this property/);
  });
});
