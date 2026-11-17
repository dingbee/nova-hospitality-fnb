/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P1 property scope — posBoard adversarial access matrix.
 *
 * posBoard is the REAL production POS floor board (tables, open orders,
 * today's stats), not just a Staff Ask LexiBite context input — this is
 * the gap staffnova.server.ts's audit first surfaced but which reaches
 * every cashier's screen. Proves a property-scoped caller's board is
 * restricted to their own property's locations, an explicit foreign
 * propertyId/locationId is denied outright, and a tenant-wide caller is
 * unaffected.
 */
import { describe, expect, it } from "vitest";
import { posBoard } from "./pos.server";

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
      role: "restaurant_manager",
      property_id: PROPERTY_A1,
    },
    { tenant_id: TENANT_A, user_id: USER_A_OWNER, role: "owner", property_id: null },
    { tenant_id: TENANT_B, user_id: USER_B1_OWNER, role: "owner", property_id: null },
  ];
  const locations = [
    { id: LOC_A1, tenant_id: TENANT_A, property_id: PROPERTY_A1 },
    { id: LOC_A2, tenant_id: TENANT_A, property_id: PROPERTY_A2 },
  ];
  const tables = [
    {
      id: "table-a1",
      code: "A1-01",
      name: "A1 Table 1",
      zone: null,
      seats: 2,
      status: "vacant",
      active: true,
      location_id: LOC_A1,
      tenant_id: TENANT_A,
    },
    {
      id: "table-a2",
      code: "A2-01",
      name: "A2 Table 1",
      zone: null,
      seats: 2,
      status: "vacant",
      active: true,
      location_id: LOC_A2,
      tenant_id: TENANT_A,
    },
  ];
  const orders: any[] = [];

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
      gte: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    function rowsFor(): any[] {
      if (table === "restaurant_members") return members;
      if (table === "restaurant_locations") return locations;
      if (table === "restaurant_tables") return tables;
      if (table === "restaurant_orders") return orders;
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

describe("P1 property scope — posBoard access matrix", () => {
  it("A1-manager's board (no explicit location) is restricted to Property A1's tables only — A2's table never appears", async () => {
    const fixture = makeFixture();
    const board = await posBoard(fixture.supabase, USER_A1_MANAGER, { tenantId: TENANT_A });
    const ids = board.tables.map((t: any) => t.id);
    expect(ids).toContain("table-a1");
    expect(ids).not.toContain("table-a2");
  });

  it("A1-manager explicitly requesting Property A2's board is DENIED", async () => {
    const fixture = makeFixture();
    await expect(
      posBoard(fixture.supabase, USER_A1_MANAGER, { tenantId: TENANT_A, propertyId: PROPERTY_A2 }),
    ).rejects.toThrow(/do not have access to this property/);
  });

  it("A1-manager explicitly requesting Property A2's location is DENIED", async () => {
    const fixture = makeFixture();
    await expect(
      posBoard(fixture.supabase, USER_A1_MANAGER, { tenantId: TENANT_A, locationId: LOC_A2 }),
    ).rejects.toThrow(/do not have access to this location/);
  });

  it("tenant-wide owner's board (no explicit location) sees tables from every property", async () => {
    const fixture = makeFixture();
    const board = await posBoard(fixture.supabase, USER_A_OWNER, { tenantId: TENANT_A });
    const ids = board.tables.map((t: any) => t.id);
    expect(ids).toContain("table-a1");
    expect(ids).toContain("table-a2");
  });

  it("cross-tenant: Tenant B's owner cannot reach Tenant A's board at all", async () => {
    const fixture = makeFixture();
    await expect(posBoard(fixture.supabase, USER_B1_OWNER, { tenantId: TENANT_A })).rejects.toThrow(
      /do not belong to this restaurant tenant/,
    );
  });
});
