/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P1 property scope — inventory ledger reconciliation (overview.server.ts's
 * listReconciliation, distinct from reconciliation.server.ts's daily-close
 * reconciliation domain). Proves the accessibleLocationIds pattern actually
 * restricts a property-scoped caller's view of restaurant_stock_
 * reconciliation_v to their own property's locations.
 */
import { describe, expect, it } from "vitest";
import { listReconciliation } from "./overview.server";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PROPERTY_A1 = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const PROPERTY_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const LOC_A1 = "10000000-a001-0000-0000-000000000001";
const LOC_A2 = "10000000-a002-0000-0000-000000000001";

const USER_A1_MANAGER = "10000000-user-0000-0000-0000000000a1";
const USER_A_OWNER = "10000000-user-0000-0000-00000000a999";
const USER_B1_OWNER = "10000000-user-0000-0000-0000000000b1";

function makeFixture() {
  const members = [
    {
      tenant_id: TENANT_A,
      user_id: USER_A1_MANAGER,
      role: "inventory_manager",
      property_id: PROPERTY_A1,
    },
    { tenant_id: TENANT_A, user_id: USER_A_OWNER, role: "owner", property_id: null },
    { tenant_id: TENANT_B, user_id: USER_B1_OWNER, role: "owner", property_id: null },
  ];
  const locations = [
    { id: LOC_A1, tenant_id: TENANT_A, property_id: PROPERTY_A1 },
    { id: LOC_A2, tenant_id: TENANT_A, property_id: PROPERTY_A2 },
  ];
  const reconciliationRows = [
    {
      location_id: LOC_A1,
      property_id: PROPERTY_A1,
      tenant_id: TENANT_A,
      drift: 0,
      item_id: "item-1",
    },
    {
      location_id: LOC_A2,
      property_id: PROPERTY_A2,
      tenant_id: TENANT_A,
      drift: 0,
      item_id: "item-2",
    },
  ];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const inFilters: Array<(r: any) => boolean> = [];
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        inFilters.push((r: any) => set.has(r[col]));
        return api;
      },
      limit: () => api,
      order: () => api,
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    function rowsFor(): any[] {
      if (table === "restaurant_members") return members;
      if (table === "restaurant_locations") return locations;
      if (table === "restaurant_stock_reconciliation_v") return reconciliationRows;
      return [];
    }

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      const rows = rowsFor().filter(
        (r) => filters.every((f) => f(r)) && inFilters.every((f) => f(r)),
      );
      if (mode === "list") return { data: rows, error: null };
      return {
        data: rows[0] ?? null,
        error: mode === "single" && !rows[0] ? { message: "not found" } : null,
      };
    }
    return api;
  }

  return {
    supabase: {
      from,
      rpc: async (fn: string) => {
        if (fn === "has_any_role") return { data: false, error: null };
        return { data: null, error: null };
      },
    },
  };
}

describe("P1 property scope — inventory ledger reconciliation (overview.server.ts)", () => {
  it("A1-manager with no explicit filter sees only Property A1's rows, never A2's", async () => {
    const fixture = makeFixture();
    const result = await listReconciliation(fixture.supabase, USER_A1_MANAGER, {
      tenantId: TENANT_A,
      limit: 100,
    } as any);
    expect(result.rows.every((r: any) => r.location_id === LOC_A1)).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("A1-manager explicitly requesting Property A2 is DENIED", async () => {
    const fixture = makeFixture();
    await expect(
      listReconciliation(fixture.supabase, USER_A1_MANAGER, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        limit: 100,
      } as any),
    ).rejects.toThrow(/not granted to you at this property/);
  });

  it("tenant-wide owner sees rows from every property", async () => {
    const fixture = makeFixture();
    const result = await listReconciliation(fixture.supabase, USER_A_OWNER, {
      tenantId: TENANT_A,
      limit: 100,
    } as any);
    const locs = new Set(result.rows.map((r: any) => r.location_id));
    expect(locs.has(LOC_A1)).toBe(true);
    expect(locs.has(LOC_A2)).toBe(true);
  });

  it("cross-tenant: Tenant B's owner cannot reach Tenant A's ledger reconciliation at all", async () => {
    const fixture = makeFixture();
    await expect(
      listReconciliation(fixture.supabase, USER_B1_OWNER, {
        tenantId: TENANT_A,
        limit: 100,
      } as any),
    ).rejects.toThrow(/requires one of/);
  });
});
