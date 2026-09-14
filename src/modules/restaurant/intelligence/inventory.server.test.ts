/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { createP05FakeSupabase, OWNER, OWNER_MEMBER, TENANT_A, TENANT_B } from "./p05.test-helpers";
import { getInventoryIntelligence } from "./inventory.server";
import type { TenantScope } from "../core/access.server";

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

/**
 * P09 enterprise closure — Multi-Location Command's bounded N+1.
 *
 * getInventoryIntelligence is called once per accessible location (up to
 * 15) by multiLocation.server.ts's fan-out. Before this change every call
 * independently re-ran assertTenantRead's own membership query and
 * re-fetched the entire tenant's supplier/supplier-product tables (neither
 * scoped to a location, so every call fetched the exact same rows) on top
 * of its own single-location items/moves query. The fix added three
 * optional inputs — `scope` (a pre-resolved TenantScope, checked
 * synchronously via canAccessProperty instead of re-querying membership),
 * `itemsData`/`movesData` (pre-filtered rows a batching caller already
 * fetched), and `refData` (pre-fetched tenant-wide suppliers/supplier-
 * products) — every one optional and additive, so the seven other callers
 * that never pass them get the exact previous behavior. These tests prove:
 * (1) the default (unscoped) path is unchanged, (2) the scope fast-path
 * enforces the same property boundary WITHOUT touching restaurant_members
 * at all, and (3) pre-fetched data is actually used instead of re-queried.
 */

const P09_TENANT = "tenant-a-p09";
const P09_PROPERTY_1 = "property-1";
const P09_PROPERTY_2 = "property-2";
const P09_USER = "user-1";

type Row = Record<string, any>;

/** Tracks every table queried via `.from(...)`, so a test can assert a table was never touched. */
function makeFakeSupabase(tables: Record<string, Row[]>) {
  const fromCalls: string[] = [];

  function builder(table: string) {
    fromCalls.push(table);
    const filters: Array<(r: Row) => boolean> = [];
    const api: any = {
      select: () => api,
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return api;
      },
      gte(col: string, val: any) {
        filters.push((r) => r[col] >= val);
        return api;
      },
      then(resolve: any) {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        resolve({ data: rows, error: null });
      },
    };
    return api;
  }

  return {
    from: (t: string) => builder(t),
    rpc: async () => ({ data: false, error: null }),
    fromCalls,
  };
}

describe("getInventoryIntelligence — default path is unchanged (no scope/pre-fetched data passed)", () => {
  it("resolves tenant read via the database (restaurant_members) and returns at-risk items", async () => {
    const sb = makeFakeSupabase({
      restaurant_members: [{ tenant_id: P09_TENANT, user_id: P09_USER, role: "owner", property_id: null }],
      restaurant_inventory_items: [
        {
          id: "item-1",
          tenant_id: P09_TENANT,
          name: "Flour",
          current_quantity: 0,
          reorder_point: 5,
          average_cost: 1000,
          currency: "TZS",
          status: "active",
        },
      ],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    const result = await getInventoryIntelligence(sb, P09_USER, { tenantId: P09_TENANT, windowDays: 30 });
    expect(result.atRisk).toHaveLength(1);
    expect(sb.fromCalls).toContain("restaurant_members");
    expect(sb.fromCalls).toContain("restaurant_inventory_items");
    expect(sb.fromCalls).toContain("restaurant_supplier_products");
    expect(sb.fromCalls).toContain("restaurant_suppliers");
  });

  it("denies a caller with no membership row, via the normal assertTenantRead path", async () => {
    const sb = makeFakeSupabase({
      restaurant_members: [],
      restaurant_inventory_items: [],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    await expect(
      getInventoryIntelligence(sb, P09_USER, { tenantId: P09_TENANT, windowDays: 30 }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/i);
  });
});

describe("getInventoryIntelligence — pre-resolved scope skips the membership query entirely", () => {
  it("denies a property-scoped caller requesting a sibling property, without ever querying restaurant_members", async () => {
    // No restaurant_members rows at all — if the function fell back to
    // assertTenantRead's DB-backed check, it would see zero grants and
    // throw a DIFFERENT error ("do not belong to this tenant") rather than
    // the property-specific one, proving the synchronous scope path ran.
    const sb = makeFakeSupabase({
      restaurant_inventory_items: [],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    const scope: TenantScope = {
      tenantId: P09_TENANT,
      platformAdmin: false,
      grants: [{ role: "owner", propertyId: P09_PROPERTY_1 }],
    };
    await expect(
      getInventoryIntelligence(sb, P09_USER, {
        tenantId: P09_TENANT,
        windowDays: 30,
        propertyId: P09_PROPERTY_2,
        scope,
      }),
    ).rejects.toThrow(/do not have access to this property/i);
    expect(sb.fromCalls).not.toContain("restaurant_members");
  });

  it("allows a property-scoped caller requesting their own property, without ever querying restaurant_members", async () => {
    const sb = makeFakeSupabase({
      restaurant_inventory_items: [],
      restaurant_stock_movements: [],
      restaurant_supplier_products: [],
      restaurant_suppliers: [],
    });
    const scope: TenantScope = {
      tenantId: P09_TENANT,
      platformAdmin: false,
      grants: [{ role: "owner", propertyId: P09_PROPERTY_1 }],
    };
    const result = await getInventoryIntelligence(sb, P09_USER, {
      tenantId: P09_TENANT,
      windowDays: 30,
      propertyId: P09_PROPERTY_1,
      scope,
    });
    expect(result.atRisk).toEqual([]);
    expect(sb.fromCalls).not.toContain("restaurant_members");
  });
});

describe("getInventoryIntelligence — pre-fetched batch data is used instead of re-queried", () => {
  it("never touches restaurant_inventory_items/restaurant_stock_movements/restaurant_supplier_products/restaurant_suppliers when itemsData/movesData/refData are supplied", async () => {
    const sb = makeFakeSupabase({
      // Deliberately seeded with rows that would change the result if
      // actually queried — proving the function used the pre-fetched
      // arrays below instead of re-fetching.
      restaurant_inventory_items: [
        { id: "wrong-item", name: "Should not appear", current_quantity: 0, reorder_point: 100 },
      ],
      restaurant_stock_movements: [{ inventory_item_id: "wrong-item", movement_type: "wastage" }],
      restaurant_supplier_products: [{ inventory_item_id: "wrong-item", unit_price: 999999 }],
      restaurant_suppliers: [{ id: "wrong-supplier", name: "Should not appear" }],
    });
    const scope: TenantScope = {
      tenantId: P09_TENANT,
      platformAdmin: true,
      grants: [],
    };
    const result = await getInventoryIntelligence(sb, P09_USER, {
      tenantId: P09_TENANT,
      windowDays: 30,
      propertyId: P09_PROPERTY_1,
      scope,
      itemsData: [
        {
          id: "item-correct",
          name: "Correct Item",
          current_quantity: 0,
          reorder_point: 5,
          average_cost: 1000,
          currency: "TZS",
          status: "active",
        },
      ],
      movesData: [],
      refData: { suppliers: [], supplierProducts: [] },
    });
    expect(result.atRisk).toHaveLength(1);
    expect(result.atRisk[0]!.inventoryItemId).toBe("item-correct");
    expect(sb.fromCalls).not.toContain("restaurant_inventory_items");
    expect(sb.fromCalls).not.toContain("restaurant_stock_movements");
    expect(sb.fromCalls).not.toContain("restaurant_supplier_products");
    expect(sb.fromCalls).not.toContain("restaurant_suppliers");
    expect(sb.fromCalls).not.toContain("restaurant_members");
  });
});
