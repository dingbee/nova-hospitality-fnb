import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({
  assertTenantRead: vi.fn().mockResolvedValue(undefined),
}));

import { getPurchasingIntelligence } from "./purchasing.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const SUPPLIER = "44444444-4444-4444-8444-444444444444";
const PRODUCT = "55555555-5555-4555-8555-555555555555";
const PO = "66666666-6666-4666-8666-666666666666";

function fakeSupabase(overrides: Record<string, unknown[]> = {}) {
  const now = Date.now();
  const tables: Record<string, unknown[]> = {
    restaurant_inventory_items: [{
      id: ITEM, name: "Fresh milk", current_quantity: 2, reorder_point: 2,
      par_level: 10, average_cost: 100, currency: "TZS", status: "active",
    }],
    restaurant_stock_movements: [{
      inventory_item_id: ITEM, movement_type: "consumption", quantity: 7,
      total_cost: 700, occurred_at: new Date(now - 86400000).toISOString(),
    }],
    restaurant_supplier_products: [{
      supplier_id: SUPPLIER, inventory_item_id: ITEM, unit_price: 100,
      lead_time_days: 2, active: true,
    }],
    restaurant_suppliers: [{
      id: SUPPLIER, name: "Fresh Supplier", lead_time_days: 2,
      reliability_score: 90, status: "active",
    }],
    restaurant_purchase_orders: [{
      id: PO, supplier_id: SUPPLIER, status: "approved",
      order_date: new Date(now - 86400000).toISOString(),
      expected_at: null, received_at: null, total: 500,
      property_id: null, location_id: null,
    }],
    restaurant_purchase_order_items: [{
      purchase_order_id: PO, inventory_item_id: ITEM, quantity: 3, received_quantity: 1,
    }],
    ...overrides,
  };

  return {
    from: (table: string) => {
      const query: any = {};
      for (const method of ["select", "eq", "gte", "in", "order", "limit"]) {
        query[method] = () => query;
      }
      query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject);
      return query;
    },
  };
}

describe("Purchasing Intelligence — inventory-to-procurement regression", () => {
  beforeEach(() => vi.clearAllMocks());

  it("subtracts outstanding quantities on open purchase orders before recommending another order", async () => {
    const result = await getPurchasingIntelligence(fakeSupabase() as any, USER, {
      tenantId: TENANT, windowDays: 7,
    });

    // Velocity is 1/day; target cover is 2-day lead time + 7-day cover = 9.
    // On hand 2 + inbound (3 ordered - 1 received) = 4; order 5, not 7.
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      inventoryItemId: ITEM,
      currentQuantity: 2,
      dailyVelocity: 1,
      recommendedQuantity: 5,
      supplierId: SUPPLIER,
      estimatedCost: 500,
    });
  });

  it("never selects an inactive supplier even when its active product is cheaper", async () => {
    const result = await getPurchasingIntelligence(fakeSupabase({
      restaurant_supplier_products: [
        { supplier_id: SUPPLIER, inventory_item_id: ITEM, unit_price: 100, lead_time_days: 2, active: true },
        { supplier_id: "inactive-supplier", inventory_item_id: ITEM, unit_price: 1, lead_time_days: 1, active: true },
      ],
      restaurant_suppliers: [
        { id: SUPPLIER, name: "Fresh Supplier", lead_time_days: 2, reliability_score: 90, status: "active" },
        { id: "inactive-supplier", name: "Inactive Supplier", lead_time_days: 1, reliability_score: 99, status: "inactive" },
      ],
    }) as any, USER, { tenantId: TENANT, windowDays: 7 });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].supplierId).toBe(SUPPLIER);
    expect(result.suggestions[0].supplierName).toBe("Fresh Supplier");
  });

  it("does not suppress a zero-stock item solely because consumption history is absent", async () => {
    const result = await getPurchasingIntelligence(fakeSupabase({
      restaurant_inventory_items: [{
        id: ITEM, name: "Fresh milk", current_quantity: 0, reorder_point: 2,
        par_level: 8, average_cost: 100, currency: "TZS", status: "active",
      }],
      restaurant_stock_movements: [],
      restaurant_purchase_orders: [],
      restaurant_purchase_order_items: [],
    }) as any, USER, { tenantId: TENANT, windowDays: 30 });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      inventoryItemId: ITEM,
      dailyVelocity: 0,
      currentQuantity: 0,
      recommendedQuantity: 8,
      supplierId: SUPPLIER,
      estimatedCost: 800,
    });
  });

  it("does not invent a replenishment quantity when zero-velocity stock has no reorder/par target", async () => {
    const result = await getPurchasingIntelligence(fakeSupabase({
      restaurant_inventory_items: [{
        id: ITEM, name: "Fresh milk", current_quantity: 0, reorder_point: null,
        par_level: null, average_cost: 100, currency: "TZS", status: "active",
      }],
      restaurant_stock_movements: [],
      restaurant_purchase_orders: [],
      restaurant_purchase_order_items: [],
    }) as any, USER, { tenantId: TENANT, windowDays: 30 });

    expect(result.suggestions).toHaveLength(0);
  });
});
