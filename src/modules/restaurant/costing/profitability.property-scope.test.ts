/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P1 property scope — Profitability adversarial access matrix.
 *
 * computeProfitability/listProfitability both require an explicit or
 * accessible propertyId/locationId; unlike load-then-check domains
 * (transfers, mobile money, fiscal), this is a report-style read where the
 * caller names the scope up front — assertCapability/assertTenantRead
 * still validate it against the caller's real membership grants before any
 * query runs, so a manipulated propertyId is refused before it can ever
 * shape the report.
 */
import { describe, expect, it } from "vitest";
import { computeProfitability, listProfitability } from "./profitability.server";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PROPERTY_A1 = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const PROPERTY_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const LOC_A1 = "10000000-a001-0000-0000-000000000001";
const LOC_A2 = "10000000-a002-0000-0000-000000000001";

const USER_A1_GM = "10000000-user-0000-0000-0000000000a1";
const USER_A_OWNER = "10000000-user-0000-0000-00000000a999";
const USER_B1_OWNER = "10000000-user-0000-0000-0000000000b1";

function makeFixture() {
  const members = [
    { tenant_id: TENANT_A, user_id: USER_A1_GM, role: "general_manager", property_id: PROPERTY_A1 },
    { tenant_id: TENANT_A, user_id: USER_A_OWNER, role: "owner", property_id: null },
    { tenant_id: TENANT_B, user_id: USER_B1_OWNER, role: "owner", property_id: null },
  ];
  const locations = [
    { id: LOC_A1, tenant_id: TENANT_A, property_id: PROPERTY_A1 },
    { id: LOC_A2, tenant_id: TENANT_A, property_id: PROPERTY_A2 },
  ];
  const snapshots = [
    {
      id: "snap-a1",
      tenant_id: TENANT_A,
      property_id: PROPERTY_A1,
      location_id: LOC_A1,
      computed_at: new Date().toISOString(),
    },
    {
      id: "snap-a2",
      tenant_id: TENANT_A,
      property_id: PROPERTY_A2,
      location_id: LOC_A2,
      computed_at: new Date().toISOString(),
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
      lte: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    function rowsFor(): any[] {
      if (table === "restaurant_members") return members;
      if (table === "restaurant_locations") return locations;
      if (table === "restaurant_profitability_snapshots") return snapshots;
      if (table === "restaurant_orders") return orders;
      if (table === "restaurant_order_items") return [];
      if (table === "restaurant_stock_movements") return [];
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

describe("P1 property scope — Profitability access matrix", () => {
  it("computeProfitability: A1-GM can compute for their own property, but is DENIED an explicit request for Property A2", async () => {
    const fixture = makeFixture();
    await expect(
      computeProfitability(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A1,
        from: "2026-01-01",
        to: "2026-01-31",
        persist: false,
        limit: 100,
      } as any),
    ).resolves.toMatchObject({ rows: [] });

    await expect(
      computeProfitability(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        from: "2026-01-01",
        to: "2026-01-31",
        persist: false,
        limit: 100,
      } as any),
    ).rejects.toThrow(/not granted to you at this property/);
  });

  it("computeProfitability: A1-GM is also denied via a manipulated locationId that resolves to Property A2", async () => {
    const fixture = makeFixture();
    await expect(
      computeProfitability(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        from: "2026-01-01",
        to: "2026-01-31",
        persist: false,
        limit: 100,
      } as any),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("computeProfitability: tenant-wide owner can compute for either property", async () => {
    const fixture = makeFixture();
    await expect(
      computeProfitability(fixture.supabase, USER_A_OWNER, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A1,
        from: "2026-01-01",
        to: "2026-01-31",
        persist: false,
        limit: 100,
      } as any),
    ).resolves.toBeDefined();
    await expect(
      computeProfitability(fixture.supabase, USER_A_OWNER, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        from: "2026-01-01",
        to: "2026-01-31",
        persist: false,
        limit: 100,
      } as any),
    ).resolves.toBeDefined();
  });

  it("listProfitability: with no explicit filter, a property-scoped caller sees only their own property's snapshots — property selector correctness downstream depends on this", async () => {
    const fixture = makeFixture();
    const a1View = await listProfitability(fixture.supabase, USER_A1_GM, {
      tenantId: TENANT_A,
      limit: 100,
    } as any);
    expect(a1View.every((r: any) => r.property_id === PROPERTY_A1)).toBe(true);
    expect(a1View.length).toBeGreaterThan(0);

    const ownerView = await listProfitability(fixture.supabase, USER_A_OWNER, {
      tenantId: TENANT_A,
      limit: 100,
    } as any);
    const props = new Set(ownerView.map((r: any) => r.property_id));
    expect(props.has(PROPERTY_A1)).toBe(true);
    expect(props.has(PROPERTY_A2)).toBe(true);
  });

  it("listProfitability: A1-GM explicitly requesting Property A2's snapshots is DENIED", async () => {
    const fixture = makeFixture();
    await expect(
      listProfitability(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        propertyId: PROPERTY_A2,
        limit: 100,
      } as any),
    ).rejects.toThrow(/do not have access to this property/);
  });

  it("cross-tenant: Tenant B's owner cannot reach Tenant A's profitability data at all", async () => {
    const fixture = makeFixture();
    await expect(
      listProfitability(fixture.supabase, USER_B1_OWNER, { tenantId: TENANT_A, limit: 100 } as any),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
    await expect(
      computeProfitability(fixture.supabase, USER_B1_OWNER, {
        tenantId: TENANT_A,
        from: "2026-01-01",
        to: "2026-01-31",
        persist: false,
        limit: 100,
      } as any),
    ).rejects.toThrow(/requires one of/);
  });
});
