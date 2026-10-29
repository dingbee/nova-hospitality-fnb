/* eslint-disable @typescript-eslint/no-explicit-any -- focused fake Supabase boundary for server intelligence. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({
  assertTenantRead: vi.fn(async () => true),
}));

import { getPurchasingIntelligence } from "./purchasing.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const SUPPLIER = "33333333-3333-4333-8333-333333333333";
const STOCK_UNIT = "44444444-4444-4444-8444-444444444444";
const PURCHASE_UNIT = "55555555-5555-4555-8555-555555555555";
const PO = "66666666-6666-4666-8666-666666666666";

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let queryErrors: Record<string, string>;

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<[string, any, string]> = [];
      const query: any = {
        select: () => query,
        eq: (column: string, value: any) => { filters.push([column, value, "eq"]); return query; },
        in: (column: string, values: any[]) => { filters.push([column, values, "in"]); return query; },
        gte: (column: string, value: any) => { filters.push([column, value, "gte"]); return query; },
        then: (resolve: (value: any) => unknown, reject?: (reason: any) => unknown) => {
          try {
            if (queryErrors[table]) return resolve({ data: null, error: { message: queryErrors[table] } });
            const rows = (tables[table] ?? []).filter((row) => filters.every(([column, value, op]) => {
              if (op === "eq") return row[column] === value;
              if (op === "in") return value.includes(row[column]);
              if (op === "gte") return String(row[column] ?? "") >= String(value);
              return true;
            }));
            return resolve({ data: rows, error: null });
          } catch (error) {
            return reject ? reject(error) : Promise.reject(error);
          }
        },
      };
      return query;
    },
  };
}

function seed(options?: { openLineUnit?: string; accepted?: number; openQuantity?: number; purchaseUnit?: string | null; packSize?: number }) {
  const now = Date.now();
  tables = {
    restaurant_inventory_items: [{
      id: ITEM, tenant_id: TENANT, property_id: null, location_id: null,
      name: "Beef", current_quantity: 2, average_cost: 20, currency: "TZS",
      unit_id: STOCK_UNIT, purchase_unit_id: options?.purchaseUnit === undefined ? PURCHASE_UNIT : options.purchaseUnit,
      pack_size: options?.packSize ?? 5,
    }],
    restaurant_stock_movements: [{
      tenant_id: TENANT, property_id: null, location_id: null, inventory_item_id: ITEM,
      movement_type: "consumption", quantity: 30, total_cost: 600, occurred_at: new Date(now - 86400000).toISOString(),
    }],
    restaurant_supplier_products: [{
      tenant_id: TENANT, supplier_id: SUPPLIER, inventory_item_id: ITEM,
      unit_id: PURCHASE_UNIT, pack_size: options?.packSize ?? 5, unit_price: 50, lead_time_days: 2, active: true,
    }],
    restaurant_suppliers: [{ tenant_id: TENANT, id: SUPPLIER, name: "Fresh Supplier", lead_time_days: 2, reliability_score: 80, status: "active" }],
    restaurant_purchase_orders: [{ tenant_id: TENANT, id: PO, supplier_id: SUPPLIER, status: "approved", order_date: null, expected_at: null, received_at: null, total: 100, property_id: null, location_id: null }],
    restaurant_purchase_order_items: [{
      tenant_id: TENANT, purchase_order_id: PO, inventory_item_id: ITEM,
      unit_id: options?.openLineUnit ?? PURCHASE_UNIT, quantity: options?.openQuantity ?? 2,
      received_quantity: 1, accepted_quantity: options?.accepted ?? 1,
    }],
  };
  queryErrors = {};
}

beforeEach(() => seed());

describe("Purchasing Intelligence procurement integrity", () => {
  it("nets accepted quantity and converts the remaining approved PO into stock units", async () => {
    const result = await getPurchasingIntelligence(fakeSupabase(), "user-1", {
      tenantId: TENANT, windowDays: 30,
    });
    expect(result.suggestions).toHaveLength(1);
    // Demand needs 9 stock units (1/day × (2 lead + 7 cover)); current stock 2
    // plus one remaining 5-unit pack covers 7, so only 2 stock units are needed.
    expect(result.suggestions[0]).toMatchObject({
      inventoryItemId: ITEM,
      recommendedQuantity: 2,
      estimatedCost: 20,
      supplierId: SUPPLIER,
    });
  });

  it("suppresses recommendations when inbound PO units cannot be normalized safely", async () => {
    seed({ openLineUnit: "77777777-7777-4777-8777-777777777777", purchaseUnit: null, packSize: 1 });
    tables.restaurant_supplier_products[0]!.unit_id = STOCK_UNIT;
    const result = await getPurchasingIntelligence(fakeSupabase(), "user-1", {
      tenantId: TENANT, windowDays: 30,
    });
    expect(result.suggestions).toHaveLength(0);
  });

  it("fails closed when a critical inventory source query fails", async () => {
    queryErrors.restaurant_purchase_order_items = "database unavailable";
    await expect(getPurchasingIntelligence(fakeSupabase(), "user-1", {
      tenantId: TENANT, windowDays: 30,
    })).rejects.toThrow(/Unable to account for outstanding purchase orders: database unavailable/);
  });
});
