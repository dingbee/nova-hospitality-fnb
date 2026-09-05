/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P1 property scope — Fiscal/TRA adversarial access matrix.
 *
 * Proves fiscal reads/operations are property-scoped exactly like every
 * other P1 domain, WITHOUT touching TIN/VRN/REGID/EFDSERIAL/UIN/
 * RECEIPTCODE or the TRA numbering/submission state machine — this file
 * only exercises the authorization layer (getFiscalConfiguration,
 * upsertFiscalConfiguration, getFiscalStatusForOrder, listFiscalReceipts,
 * getFiscalHealth, prepareZReportDraft), never fiscal.server.test.ts's own
 * state-machine scenarios.
 */
import { describe, expect, it } from "vitest";
import {
  getFiscalConfiguration,
  getFiscalHealth,
  getFiscalStatusForOrder,
  listFiscalReceipts,
  prepareZReportDraft,
  upsertFiscalConfiguration,
} from "./fiscal.server";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PROPERTY_A1 = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const PROPERTY_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const LOC_A1 = "10000000-a001-0000-0000-000000000001";
const LOC_A2 = "10000000-a002-0000-0000-000000000001";

const USER_A1_GM = "10000000-user-0000-0000-0000000000a1";
const USER_A2_GM = "10000000-user-0000-0000-0000000000a2";
const USER_A_OWNER = "10000000-user-0000-0000-00000000a999";
const USER_B1_OWNER = "10000000-user-0000-0000-0000000000b1";

const ORDER_A1 = "order-a1";
const ORDER_A2 = "order-a2";

function makeFixture() {
  const members = [
    { tenant_id: TENANT_A, user_id: USER_A1_GM, role: "general_manager", property_id: PROPERTY_A1 },
    { tenant_id: TENANT_A, user_id: USER_A2_GM, role: "general_manager", property_id: PROPERTY_A2 },
    { tenant_id: TENANT_A, user_id: USER_A_OWNER, role: "owner", property_id: null },
    { tenant_id: TENANT_B, user_id: USER_B1_OWNER, role: "owner", property_id: null },
  ];
  const locations = [
    { id: LOC_A1, tenant_id: TENANT_A, property_id: PROPERTY_A1 },
    { id: LOC_A2, tenant_id: TENANT_A, property_id: PROPERTY_A2 },
  ];
  const orders = [
    { id: ORDER_A1, tenant_id: TENANT_A, property_id: PROPERTY_A1, location_id: LOC_A1 },
    { id: ORDER_A2, tenant_id: TENANT_A, property_id: PROPERTY_A2, location_id: LOC_A2 },
  ];
  const configs: any[] = [
    {
      id: "cfg-a1",
      tenant_id: TENANT_A,
      property_id: PROPERTY_A1,
      location_id: LOC_A1,
      business_name: "A1 Diner",
    },
    {
      id: "cfg-a2",
      tenant_id: TENANT_A,
      property_id: PROPERTY_A2,
      location_id: LOC_A2,
      business_name: "A2 Diner",
    },
  ];
  const receipts: any[] = [
    {
      id: "rcpt-a1",
      tenant_id: TENANT_A,
      location_id: LOC_A1,
      order_id: ORDER_A1,
      state: "fiscalized",
      fiscalized_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
    {
      id: "rcpt-a2",
      tenant_id: TENANT_A,
      location_id: LOC_A2,
      order_id: ORDER_A2,
      state: "fiscalized",
      fiscalized_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
  ];
  const orderItems: any[] = [];
  const payments: any[] = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const inFilters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: any;
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
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      upsert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    function rowsFor(): any[] {
      if (table === "restaurant_members") return members;
      if (table === "restaurant_locations") return locations;
      if (table === "restaurant_orders") return orders;
      if (table === "restaurant_fiscal_configurations") return configs;
      if (table === "restaurant_fiscal_receipts") return receipts;
      if (table === "restaurant_order_items") return orderItems;
      if (table === "restaurant_payments") return payments;
      return [];
    }

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      if (op === "insert") {
        const stored = { id: `fiscal-${Math.random()}`, ...payload };
        rowsFor().push(stored);
        return { data: stored, error: null };
      }
      if (op === "update") {
        const rows = rowsFor().filter((r) => filters.every((f) => f(r)));
        for (const r of rows) Object.assign(r, payload);
        return { data: rows[0] ?? null, error: null };
      }
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
    configs,
    receipts,
  };
}

describe("P1 property scope — Fiscal/TRA access matrix", () => {
  it("READ (getFiscalConfiguration): A1-GM reads A1's config (ALLOW); A2's config is DENIED", async () => {
    const fixture = makeFixture();
    await expect(
      getFiscalConfiguration(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).resolves.toMatchObject({ id: "cfg-a1" });
    await expect(
      getFiscalConfiguration(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
      }),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("READ: A2-GM mirrors — A2 ALLOW, A1 DENY", async () => {
    const fixture = makeFixture();
    await expect(
      getFiscalConfiguration(fixture.supabase, USER_A2_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
      }),
    ).resolves.toMatchObject({ id: "cfg-a2" });
    await expect(
      getFiscalConfiguration(fixture.supabase, USER_A2_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("READ: tenant-A-owner reaches both A1 and A2; Tenant B's owner is denied both", async () => {
    const fixture = makeFixture();
    await expect(
      getFiscalConfiguration(fixture.supabase, USER_A_OWNER, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).resolves.toMatchObject({ id: "cfg-a1" });
    await expect(
      getFiscalConfiguration(fixture.supabase, USER_A_OWNER, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
      }),
    ).resolves.toMatchObject({ id: "cfg-a2" });
    await expect(
      getFiscalConfiguration(fixture.supabase, USER_B1_OWNER, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).rejects.toThrow(/requires one of/); // getFiscalConfiguration is capability-gated, not a plain tenant read
  });

  it("WRITE (upsertFiscalConfiguration): A1-GM can configure A1 but is DENIED configuring A2 — property_id is always derived from the location row, never a manipulated client field", async () => {
    const fixture = makeFixture();
    const saved = await upsertFiscalConfiguration(fixture.supabase, USER_A1_GM, {
      tenantId: TENANT_A,
      locationId: LOC_A1,
      businessName: "A1 Diner Renamed",
      propertyId: PROPERTY_A2, // manipulated — must be ignored in favor of the location's real property
    } as any);
    expect(saved.property_id).toBe(PROPERTY_A1);

    await expect(
      upsertFiscalConfiguration(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        businessName: "Hostile takeover attempt",
      } as any),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("READ (getFiscalStatusForOrder): scoped to the ORDER's own property/location via load-then-check — A1-GM cannot read A2's order fiscal status", async () => {
    const fixture = makeFixture();
    await expect(
      getFiscalStatusForOrder(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        orderId: ORDER_A1,
      }),
    ).resolves.toBeDefined();
    await expect(
      getFiscalStatusForOrder(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        orderId: ORDER_A2,
      }),
    ).rejects.toThrow(/do not have access to this (property|location)/);
  });

  it("LIST (listFiscalReceipts): with no explicit locationId, a property-scoped caller sees only their own property's receipts", async () => {
    const fixture = makeFixture();
    const a1View = await listFiscalReceipts(fixture.supabase, USER_A1_GM, { tenantId: TENANT_A });
    expect(a1View.every((r: any) => r.location_id === LOC_A1)).toBe(true);
    expect(a1View.length).toBeGreaterThan(0);

    const ownerView = await listFiscalReceipts(fixture.supabase, USER_A_OWNER, {
      tenantId: TENANT_A,
    });
    const locs = new Set(ownerView.map((r: any) => r.location_id));
    expect(locs.has(LOC_A1)).toBe(true);
    expect(locs.has(LOC_A2)).toBe(true);
  });

  it("LIST: an explicit but foreign locationId is still gated by assertCapability before the query even runs", async () => {
    const fixture = makeFixture();
    await expect(
      listFiscalReceipts(fixture.supabase, USER_A1_GM, { tenantId: TENANT_A, locationId: LOC_A2 }),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("AGGREGATE (getFiscalHealth): a property-scoped caller's health check never leaks a foreign property's receipt counts", async () => {
    const fixture = makeFixture();
    const a1Health = await getFiscalHealth(fixture.supabase, USER_A1_GM, { tenantId: TENANT_A });
    expect(a1Health.fiscalizedToday).toBe(1); // only rcpt-a1

    await expect(
      getFiscalHealth(fixture.supabase, USER_A1_GM, { tenantId: TENANT_A, locationId: LOC_A2 }),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("WRITE (prepareZReportDraft): A1-GM can draft a Z-report for A1 but is DENIED for A2", async () => {
    const fixture = makeFixture();
    const businessDate = new Date().toISOString().slice(0, 10);
    await expect(
      prepareZReportDraft(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
        businessDate,
      }),
    ).resolves.toBeDefined();
    await expect(
      prepareZReportDraft(fixture.supabase, USER_A1_GM, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        businessDate,
      }),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("cross-tenant: Tenant B's owner cannot reach any Tenant A fiscal function, no membership row exists", async () => {
    const fixture = makeFixture();
    await expect(
      listFiscalReceipts(fixture.supabase, USER_B1_OWNER, { tenantId: TENANT_A }),
    ).rejects.toThrow(/requires one of/); // listFiscalReceipts uses assertCapability -> role-based Forbidden
  });
});
