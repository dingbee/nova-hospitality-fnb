import { describe, expect, it } from "vitest";
import { createP05FakeSupabase, OWNER, OWNER_MEMBER, TENANT_A, TENANT_B } from "./p05.test-helpers";
import { getPurchasingIntelligence } from "./purchasing.server";

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
    current_quantity: 2,
    average_cost: 10,
    currency: "TZS",
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
    quantity: -5,
    total_cost: 50,
    occurred_at: iso(daysAgo),
    ...extra,
  };
}

function po(id: string, supplierId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_A,
    property_id: null,
    location_id: null,
    supplier_id: supplierId,
    status: "received",
    order_date: iso(10),
    expected_at: iso(7).slice(0, 10),
    received_at: iso(6),
    total: 100,
    ...extra,
  };
}

describe("getPurchasingIntelligence — correctness", () => {
  it("recommends a purchase quantity from consumption velocity", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [item("i1", { current_quantity: 1 })],
      restaurant_stock_movements: [move("i1", 1), move("i1", 2), move("i1", 3)],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
      restaurant_purchase_orders: [],
    });
    const result = await getPurchasingIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
    });
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]?.inventoryItemId).toBe("i1");
  });

  it("ranks suppliers by on-time delivery performance", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [
        {
          id: "s-good",
          name: "Good Supplier",
          lead_time_days: 3,
          reliability_score: null,
          status: "active",
          tenant_id: TENANT_A,
        },
        {
          id: "s-bad",
          name: "Bad Supplier",
          lead_time_days: 3,
          reliability_score: null,
          status: "active",
          tenant_id: TENANT_A,
        },
      ],
      restaurant_purchase_orders: [
        po("po1", "s-good", { expected_at: iso(6).slice(0, 10), received_at: iso(6) }),
        po("po2", "s-bad", { expected_at: iso(9).slice(0, 10), received_at: iso(6) }),
      ],
    });
    const result = await getPurchasingIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
    });
    const good = result.suppliers.find((s) => s.supplierId === "s-good");
    const bad = result.suppliers.find((s) => s.supplierId === "s-bad");
    expect(good?.score ?? 0).toBeGreaterThan(bad?.score ?? 0);
  });
});

describe("getPurchasingIntelligence — tenant isolation", () => {
  it("never mixes another tenant's inventory items into suggestions", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [
        item("a-item", { current_quantity: 1 }),
        item("b-item", { tenant_id: TENANT_B, current_quantity: 1 }),
      ],
      restaurant_stock_movements: [move("a-item", 1), move("b-item", 1, { tenant_id: TENANT_B })],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
      restaurant_purchase_orders: [],
    });
    const result = await getPurchasingIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
    });
    expect(result.suggestions.every((s) => s.inventoryItemId !== "b-item")).toBe(true);
  });

  it("never mixes another tenant's suppliers/purchase orders into the reliability ranking", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [
        { id: "a-supplier", name: "A Supplier", tenant_id: TENANT_A, status: "active" },
        { id: "b-supplier", name: "B Supplier", tenant_id: TENANT_B, status: "active" },
      ],
      restaurant_purchase_orders: [
        po("a-po", "a-supplier"),
        po("b-po", "b-supplier", { tenant_id: TENANT_B }),
      ],
    });
    const result = await getPurchasingIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
    });
    expect(result.suppliers.map((s) => s.supplierId)).not.toContain("b-supplier");
  });

  it("rejects a caller with no membership in the tenant", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [],
      restaurant_inventory_items: [],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
      restaurant_purchase_orders: [],
    });
    await expect(
      getPurchasingIntelligence(sb, OWNER, { tenantId: TENANT_A, windowDays: 7 }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });
});

describe("getPurchasingIntelligence — property isolation", () => {
  it("excludes another property's purchase orders from a property-scoped supplier ranking", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER], // tenant-wide grant — legitimately sees every property
      restaurant_inventory_items: [],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [
        { id: "shared-supplier", name: "Shared Supplier", tenant_id: TENANT_A, status: "active" },
      ],
      restaurant_purchase_orders: [
        po("po-a", "shared-supplier", { property_id: "prop-a" }),
        po("po-b", "shared-supplier", { property_id: "prop-b" }),
      ],
    });
    const result = await getPurchasingIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      propertyId: "prop-a",
    });
    const supplier = result.suppliers.find((s) => s.supplierId === "shared-supplier");
    expect(supplier?.orders).toBe(1);
  });

  it("excludes another property's inventory/consumption from suggestions", async () => {
    const sb = createP05FakeSupabase({
      restaurant_members: [OWNER_MEMBER],
      restaurant_inventory_items: [
        item("a-item", { property_id: "prop-a", current_quantity: 1 }),
        item("b-item", { property_id: "prop-b", current_quantity: 1 }),
      ],
      restaurant_stock_movements: [
        move("a-item", 1, { property_id: "prop-a" }),
        move("b-item", 1, { property_id: "prop-b" }),
      ],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
      restaurant_purchase_orders: [],
    });
    const result = await getPurchasingIntelligence(sb, OWNER, {
      tenantId: TENANT_A,
      windowDays: 7,
      propertyId: "prop-a",
    });
    expect(result.suggestions.every((s) => s.inventoryItemId !== "b-item")).toBe(true);
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
      restaurant_purchase_orders: [],
    });
    await expect(
      getPurchasingIntelligence(sb, OWNER, {
        tenantId: TENANT_A,
        windowDays: 7,
        propertyId: "prop-forged",
      }),
    ).rejects.toThrow(/do not have access to this property/);
  });
});
