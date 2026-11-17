/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P1 property scope — receipts.server.ts adversarial access matrix.
 *
 * requestFiscalization (fiscal.server.ts) deliberately never checks
 * capability itself — it trusts an already-authorized, scope-checked sales
 * flow. issueReceipt/getReceipt are that check: both load the order's own
 * property/location BEFORE calling assertCapability/assertTenantRead
 * (load-then-check), closing the real gap that would otherwise let staff
 * scoped to one property reach another property's receipt/fiscal request
 * merely by holding some role in the tenant.
 */
import { describe, expect, it } from "vitest";
import { getReceipt, issueReceipt } from "./receipts.server";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PROPERTY_A1 = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const PROPERTY_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const LOC_A1 = "10000000-a001-0000-0000-000000000001";
const LOC_A2 = "10000000-a002-0000-0000-000000000001";

const USER_A1_MANAGER = "10000000-user-0000-0000-0000000000a1";
const USER_A_OWNER = "10000000-user-0000-0000-00000000a999";
const USER_B1_OWNER = "10000000-user-0000-0000-0000000000b1";

const ORDER_A1 = "order-a1";
const ORDER_A2 = "order-a2";

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
  const orders = [
    { id: ORDER_A1, tenant_id: TENANT_A, property_id: PROPERTY_A1, location_id: LOC_A1 },
    { id: ORDER_A2, tenant_id: TENANT_A, property_id: PROPERTY_A2, location_id: LOC_A2 },
  ];
  const receipts = [
    { id: "rcpt-a1", tenant_id: TENANT_A, order_id: ORDER_A1, reprint_count: 0 },
    { id: "rcpt-a2", tenant_id: TENANT_A, order_id: ORDER_A2, reprint_count: 0 },
  ];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      order: () => api,
      update: () => ({
        eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
      }),
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    function rowsFor(): any[] {
      if (table === "restaurant_members") return members;
      if (table === "restaurant_locations") return locations;
      if (table === "restaurant_orders") return orders;
      if (table === "restaurant_receipts") return receipts;
      return [];
    }

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      const rows = rowsFor().filter((r) => filters.every((f) => f(r)));
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

describe("P1 property scope — Receipts (and the fiscalization gap it closes)", () => {
  it("issueReceipt: A1-manager can reprint A1's receipt but is DENIED reaching A2's — scope comes from the ORDER, not the caller's tenant-level role alone", async () => {
    const fixture = makeFixture();
    await expect(
      issueReceipt(fixture.supabase, USER_A1_MANAGER, { tenantId: TENANT_A, orderId: ORDER_A1 }),
    ).resolves.toBeDefined();
    await expect(
      issueReceipt(fixture.supabase, USER_A1_MANAGER, { tenantId: TENANT_A, orderId: ORDER_A2 }),
    ).rejects.toThrow(/not granted to you at this (property|location)/);
  });

  it("getReceipt: A1-manager can read A1's receipt but is DENIED A2's", async () => {
    const fixture = makeFixture();
    await expect(
      getReceipt(fixture.supabase, USER_A1_MANAGER, { tenantId: TENANT_A, orderId: ORDER_A1 }),
    ).resolves.toBeDefined();
    await expect(
      getReceipt(fixture.supabase, USER_A1_MANAGER, { tenantId: TENANT_A, orderId: ORDER_A2 }),
    ).rejects.toThrow(/do not have access to this (property|location)/);
  });

  it("tenant-wide owner reaches both A1 and A2 receipts", async () => {
    const fixture = makeFixture();
    await expect(
      getReceipt(fixture.supabase, USER_A_OWNER, { tenantId: TENANT_A, orderId: ORDER_A1 }),
    ).resolves.toBeDefined();
    await expect(
      getReceipt(fixture.supabase, USER_A_OWNER, { tenantId: TENANT_A, orderId: ORDER_A2 }),
    ).resolves.toBeDefined();
  });

  it("cross-tenant: Tenant B's owner cannot reach a Tenant A receipt at all", async () => {
    const fixture = makeFixture();
    await expect(
      getReceipt(fixture.supabase, USER_B1_OWNER, { tenantId: TENANT_A, orderId: ORDER_A1 }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });
});
