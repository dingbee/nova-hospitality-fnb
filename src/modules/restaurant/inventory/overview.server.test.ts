/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-13: getInventoryOverview had no regression coverage at all. Written
 * alongside the fix that converts its transfers/batches/stocktake-variance
 * queries from "fetch every matching row just to read .length" to
 * PostgREST's count-only `head: true` mode — this proves the aggregate
 * numbers are still computed correctly through that path, and that a
 * caller who never triggers the count-only branches (locationId query in
 * the fixture) still gets a correct answer.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({
  assertTenantRead: vi.fn(async () => true),
  assertCapability: vi.fn(async () => true),
  getTenantScope: vi.fn(async () => ({ isPlatformAdmin: true, grants: [] })),
  accessibleLocationIds: vi.fn(async () => null),
  NO_MATCH_ID: "00000000-0000-0000-0000-000000000000",
}));
vi.mock("./positions.server", () => ({
  incomingIndex: vi.fn(async () => new Map([["item-1", 3]])),
}));
vi.mock("./locations.server", () => ({
  locationNameMap: vi.fn(async () => new Map()),
}));

import { getInventoryOverview } from "./overview.server";

const TENANT = "11111111-1111-4111-8111-111111111111";

function makeFixture() {
  const now = new Date().toISOString();
  const items = [
    {
      id: "item-1",
      tenant_id: TENANT,
      currency: "TZS",
      current_quantity: 10,
      average_cost: 1000,
      reorder_point: 5,
      location_id: "loc-1",
      property_id: "prop-1",
      status: "active",
    },
    {
      id: "item-2",
      tenant_id: TENANT,
      currency: "TZS",
      current_quantity: 2,
      average_cost: 500,
      reorder_point: 5,
      location_id: "loc-1",
      property_id: "prop-1",
      status: "active",
    },
    {
      id: "item-3",
      tenant_id: TENANT,
      currency: "TZS",
      current_quantity: 0,
      average_cost: 800,
      reorder_point: 3,
      location_id: "loc-1",
      property_id: "prop-1",
      status: "active",
    },
  ];
  const transfers = [
    { id: "t-1", tenant_id: TENANT, status: "requested" },
    { id: "t-2", tenant_id: TENANT, status: "dispatched" },
  ];
  const wastageMovements = [
    { tenant_id: TENANT, movement_type: "wastage", total_cost: 1500, occurred_at: now },
    { tenant_id: TENANT, movement_type: "wastage", total_cost: 500, occurred_at: now },
  ];
  const batches = [{ id: "b-1", tenant_id: TENANT, quantity: 5, expiry_date: now.slice(0, 10) }];
  const locations = [{ id: "loc-store", tenant_id: TENANT, is_storage: true }];
  const stocktakes = [{ id: "st-1", tenant_id: TENANT, variance_value: 12, created_at: now }];

  function query(table: string) {
    const filters: Array<[string, any]> = [];
    let headCount = false;
    const api: any = {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        headCount = Boolean(opts?.head);
        return api;
      },
      eq(col: string, val: any) {
        filters.push([col, val]);
        return api;
      },
      gt(col: string, val: any) {
        filters.push([col, { __gt: val }]);
        return api;
      },
      gte(col: string, val: any) {
        filters.push([col, { __gte: val }]);
        return api;
      },
      lte(col: string, val: any) {
        filters.push([col, { __lte: val }]);
        return api;
      },
      in(col: string, vals: any[]) {
        const set = new Set(vals);
        filters.push([col, { __in: set }]);
        return api;
      },
      then(resolve: any) {
        const rows = rowsFor(table).filter((r) =>
          filters.every(([c, v]) => {
            if (v && typeof v === "object" && "__gt" in v) return Number(r[c]) > v.__gt;
            if (v && typeof v === "object" && "__gte" in v) return r[c] >= v.__gte;
            if (v && typeof v === "object" && "__lte" in v) return r[c] <= v.__lte;
            if (v && typeof v === "object" && "__in" in v) return v.__in.has(r[c]);
            return r[c] === v;
          }),
        );
        if (headCount)
          return Promise.resolve(resolve({ data: null, count: rows.length, error: null }));
        return Promise.resolve(resolve({ data: rows, error: null }));
      },
    };
    return api;
  }

  function rowsFor(table: string): any[] {
    switch (table) {
      case "restaurant_inventory_items":
        return items;
      case "restaurant_stock_transfers":
        return transfers;
      case "restaurant_stock_movements":
        return wastageMovements;
      case "restaurant_inventory_batches":
        return batches;
      case "restaurant_locations":
        return locations;
      case "restaurant_stocktakes":
        return stocktakes;
      default:
        return [];
    }
  }

  return { from: (t: string) => query(t) };
}

describe("getInventoryOverview", () => {
  it("computes stock value, reorder/critical counts and count-only aggregates correctly", async () => {
    const sb = makeFixture();
    const result = await getInventoryOverview(sb, "user-1", { tenantId: TENANT } as any);

    expect(result.totalStockValue).toBe(10 * 1000 + 2 * 500 + 0 * 800);
    expect(result.itemsBelowReorder).toBe(2); // item-2 (2<=5) and item-3 (0<=3)
    expect(result.criticalItems).toBe(1); // item-3 only
    expect(result.transfersPending).toBe(2);
    expect(result.stocktakeVariances).toBe(1);
    expect(result.expiringSoon).toBe(1);
    expect(result.recentWasteValue).toBe(2000);
    expect(result.incomingToday).toBe(3);
    expect(result.currency).toBe("TZS");
  });
});
