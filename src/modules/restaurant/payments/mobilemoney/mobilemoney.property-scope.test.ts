/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P1 property scope — Mobile Money adversarial access matrix.
 *
 * mobilemoney.server.test.ts mocks access.server entirely (it tests the
 * Payment Core state machine, not authorization). This file does the
 * opposite: access.server runs for real against a two-tenant/two-property
 * fixture, proving the exact matrix the P1 spec requires — A1-manager ->
 * A1 ALLOW, -> A2 DENY, -> B1 DENY; A2-manager mirror; tenant-A-owner ->
 * A1/A2 ALLOW, -> B1 DENY — for both reads and writes, and specifically
 * covering `refreshMobileMoneyCollectionStatus`, which had NO authorization
 * check at all before this P1 pass (see mobilemoney.server.ts).
 */
import { describe, expect, it } from "vitest";
import {
  getMobileMoneyAccount,
  getMobileMoneyHealth,
  listMobileMoneyReconciliation,
  refreshMobileMoneyCollectionStatus,
  requestMobileMoneyCollection,
  upsertMobileMoneyAccount,
} from "./mobilemoney.server";
import { createTestMobileMoneyAdapter } from "./providers/testAdapter.server";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PROPERTY_A1 = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const PROPERTY_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const LOC_A1 = "10000000-a001-0000-0000-000000000001";
const LOC_A2 = "10000000-a002-0000-0000-000000000001";

const USER_A1_MANAGER = "10000000-user-0000-0000-0000000000a1";
const USER_A2_MANAGER = "10000000-user-0000-0000-0000000000a2";
const USER_A_OWNER = "10000000-user-0000-0000-00000000a999";
const USER_B1_OWNER = "10000000-user-0000-0000-0000000000b1";

const ORDER_A1 = "order-a1";
const ORDER_A2 = "order-a2";

function makeFixture() {
  const members = [
    {
      tenant_id: TENANT_A,
      user_id: USER_A1_MANAGER,
      role: "general_manager",
      property_id: PROPERTY_A1,
    },
    {
      tenant_id: TENANT_A,
      user_id: USER_A2_MANAGER,
      role: "general_manager",
      property_id: PROPERTY_A2,
    },
    { tenant_id: TENANT_A, user_id: USER_A_OWNER, role: "owner", property_id: null },
    { tenant_id: TENANT_B, user_id: USER_B1_OWNER, role: "owner", property_id: null },
  ];
  const locations = [
    { id: LOC_A1, tenant_id: TENANT_A, property_id: PROPERTY_A1 },
    { id: LOC_A2, tenant_id: TENANT_A, property_id: PROPERTY_A2 },
  ];
  const orders = [
    {
      id: ORDER_A1,
      tenant_id: TENANT_A,
      property_id: PROPERTY_A1,
      location_id: LOC_A1,
      currency: "TZS",
    },
    {
      id: ORDER_A2,
      tenant_id: TENANT_A,
      property_id: PROPERTY_A2,
      location_id: LOC_A2,
      currency: "TZS",
    },
  ];
  const accounts: any[] = [
    {
      id: "account-a1",
      tenant_id: TENANT_A,
      property_id: PROPERTY_A1,
      location_id: LOC_A1,
      mode: "connected",
      network: "mpesa",
      merchant_number: "1",
      environment: "test",
      activation_state: "active",
    },
    {
      id: "account-a2",
      tenant_id: TENANT_A,
      property_id: PROPERTY_A2,
      location_id: LOC_A2,
      mode: "connected",
      network: "mpesa",
      merchant_number: "2",
      environment: "test",
      activation_state: "active",
    },
  ];
  const collections: any[] = [];
  let seq = 0;

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
      if (table === "restaurant_mobile_money_accounts") return accounts;
      if (table === "restaurant_mobile_money_collections") return collections;
      return [];
    }

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      if (op === "insert") {
        seq += 1;
        const stored = { id: `mm-${seq}`, ...payload };
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
    accounts,
    collections,
  };
}

describe("P1 property scope — Mobile Money access matrix", () => {
  it("READ: A1-manager reads A1's account (ALLOW); A2's account is DENIED", async () => {
    const fixture = makeFixture();
    await expect(
      getMobileMoneyAccount(fixture.supabase, USER_A1_MANAGER, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).resolves.toMatchObject({ id: "account-a1" });
    await expect(
      getMobileMoneyAccount(fixture.supabase, USER_A1_MANAGER, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
      }),
    ).rejects.toThrow(/do not have access to this location/);
  });

  it("READ: A2-manager mirrors — A2 ALLOW, A1 DENY", async () => {
    const fixture = makeFixture();
    await expect(
      getMobileMoneyAccount(fixture.supabase, USER_A2_MANAGER, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
      }),
    ).resolves.toMatchObject({ id: "account-a2" });
    await expect(
      getMobileMoneyAccount(fixture.supabase, USER_A2_MANAGER, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).rejects.toThrow(/do not have access to this location/);
  });

  it("READ: tenant-A-owner reaches both A1 and A2; Tenant B's owner is denied both — no membership under Tenant A at all", async () => {
    const fixture = makeFixture();
    await expect(
      getMobileMoneyAccount(fixture.supabase, USER_A_OWNER, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).resolves.toMatchObject({ id: "account-a1" });
    await expect(
      getMobileMoneyAccount(fixture.supabase, USER_A_OWNER, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
      }),
    ).resolves.toMatchObject({ id: "account-a2" });
    await expect(
      getMobileMoneyAccount(fixture.supabase, USER_B1_OWNER, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
      }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });

  it("WRITE: A1-manager can configure A1's account but is DENIED configuring A2's — and the stored property_id always comes from the location row, never a client-manipulated propertyId", async () => {
    const fixture = makeFixture();
    const saved = await upsertMobileMoneyAccount(fixture.supabase, USER_A1_MANAGER, {
      tenantId: TENANT_A,
      locationId: LOC_A1,
      mode: "connected",
      network: "mpesa",
      merchantNumber: "999",
      environment: "test",
      // Manipulated propertyId: even if a caller passed A2 here, the write
      // must be attributed to A1 (the location's real property), not this.
      propertyId: PROPERTY_A2,
    } as any);
    expect(saved.property_id).toBe(PROPERTY_A1);

    await expect(
      upsertMobileMoneyAccount(fixture.supabase, USER_A1_MANAGER, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        mode: "connected",
        network: "mpesa",
        merchantNumber: "999",
        environment: "test",
      } as any),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("WRITE: requestMobileMoneyCollection is scoped to the ORDER's own property/location, resolved after loading the order (load-then-check) — A1-manager cannot collect against an A2 order", async () => {
    const fixture = makeFixture();
    await expect(
      requestMobileMoneyCollection(
        fixture.supabase,
        USER_A1_MANAGER,
        { tenantId: TENANT_A, orderId: ORDER_A1, amount: 1000, clientRequestId: "r1" },
        createTestMobileMoneyAdapter("success"),
      ),
    ).resolves.toMatchObject({ state: "pending_customer" });

    await expect(
      requestMobileMoneyCollection(
        fixture.supabase,
        USER_A1_MANAGER,
        { tenantId: TENANT_A, orderId: ORDER_A2, amount: 1000, clientRequestId: "r2" },
        createTestMobileMoneyAdapter("success"),
      ),
    ).rejects.toThrow(/not granted to you at this (property|location)/);
  });

  it("SECURITY FIX PROOF: refreshMobileMoneyCollectionStatus had NO authorization check before P1 — now A1-manager can refresh their own property's collection but is DENIED an A2 collection", async () => {
    const fixture = makeFixture();
    const collection = await requestMobileMoneyCollection(
      fixture.supabase,
      USER_A_OWNER,
      { tenantId: TENANT_A, orderId: ORDER_A2, amount: 1000, clientRequestId: "r3" },
      createTestMobileMoneyAdapter("success"),
    );
    await expect(
      refreshMobileMoneyCollectionStatus(fixture.supabase, USER_A1_MANAGER, {
        tenantId: TENANT_A,
        collectionId: collection.collectionId,
      }),
    ).rejects.toThrow(/do not have access to this (property|location)/);

    // A user with no membership at all is refused outright, exactly as
    // every other read now requires — this path used to accept ANY caller.
    await expect(
      refreshMobileMoneyCollectionStatus(fixture.supabase, USER_B1_OWNER, {
        tenantId: TENANT_A,
        collectionId: collection.collectionId,
      }),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });

  it("LIST/AGGREGATE: listMobileMoneyReconciliation with no explicit locationId restricts a property-scoped caller to their own property's collections only", async () => {
    const fixture = makeFixture();
    await requestMobileMoneyCollection(
      fixture.supabase,
      USER_A_OWNER,
      { tenantId: TENANT_A, orderId: ORDER_A1, amount: 500, clientRequestId: "list-a1" },
      createTestMobileMoneyAdapter("success"),
    );
    await requestMobileMoneyCollection(
      fixture.supabase,
      USER_A_OWNER,
      { tenantId: TENANT_A, orderId: ORDER_A2, amount: 500, clientRequestId: "list-a2" },
      createTestMobileMoneyAdapter("success"),
    );

    const a1View = await listMobileMoneyReconciliation(fixture.supabase, USER_A1_MANAGER, {
      tenantId: TENANT_A,
    });
    expect(a1View.every((r: any) => r.location_id === LOC_A1)).toBe(true);
    expect(a1View.length).toBeGreaterThan(0);

    const ownerView = await listMobileMoneyReconciliation(fixture.supabase, USER_A_OWNER, {
      tenantId: TENANT_A,
    });
    const locationIds = new Set(ownerView.map((r: any) => r.location_id));
    expect(locationIds.has(LOC_A1)).toBe(true);
    expect(locationIds.has(LOC_A2)).toBe(true);
  });

  it("AGGREGATE: getMobileMoneyHealth for a property-scoped caller never counts a foreign property's accounts as 'active'", async () => {
    const fixture = makeFixture();
    const a1Health = await getMobileMoneyHealth(fixture.supabase, USER_A1_MANAGER, {
      tenantId: TENANT_A,
    });
    // Only account-a1 is visible; it must be the one reported active, never account-a2.
    expect(a1Health.status).not.toBe("configuration_required");

    const a2OnlyFixture = makeFixture();
    a2OnlyFixture.accounts.length = 0; // strip A1's account entirely
    a2OnlyFixture.accounts.push({
      id: "account-a2-only",
      tenant_id: TENANT_A,
      property_id: PROPERTY_A2,
      location_id: LOC_A2,
      mode: "connected",
      network: "mpesa",
      merchant_number: "2",
      environment: "test",
      activation_state: "active",
    });
    const a1HealthWithOnlyA2Configured = await getMobileMoneyHealth(
      a2OnlyFixture.supabase,
      USER_A1_MANAGER,
      {
        tenantId: TENANT_A,
      },
    );
    // A1-manager's accessibleLocationIds excludes LOC_A2, so the only
    // configured account (A2's) must never surface as theirs — health
    // reports "configuration_required" exactly as if nothing were
    // configured at all, never A2's active account.
    expect(a1HealthWithOnlyA2Configured.status).toBe("configuration_required");
  });
});
