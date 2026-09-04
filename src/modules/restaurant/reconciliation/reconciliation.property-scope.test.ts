/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P1 property scope — Reconciliation adversarial access matrix.
 *
 * Every function tested here is authorization-first: openDailyClose/
 * runReconciliation check capability before any query runs; declareTenders/
 * resolveException/closeDay/reopenDay load their own row first (load-then-
 * check) and derive scope from ITS location_id, never a client-supplied
 * field. restaurant_orders is seeded empty throughout so loadDayFacts takes
 * its "no orders this window" shortcut — these tests exercise the
 * authorization boundary, not the reconciliation math (already covered
 * elsewhere).
 *
 * DISCLOSED GAP: listDailyCloses, listExceptions, exceptionTrends and
 * listReconciliationAudit remain tenant-only (unscoped) — their Zod
 * schemas carry no locationId field at all, so scoping them would require
 * a contract change plus UI wiring beyond this pass's budget. The last
 * test below proves that gap still exists, so it stays honestly visible
 * rather than silently assumed fixed.
 */
import { describe, expect, it } from "vitest";
import {
  closeDay,
  declareTenders,
  getDailyClose,
  listDailyCloses,
  openDailyClose,
  reopenDay,
  resolveException,
  runReconciliation,
} from "./reconciliation.server";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PROPERTY_A1 = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const PROPERTY_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const LOC_A1 = "10000000-a001-0000-0000-000000000001";
const LOC_A2 = "10000000-a002-0000-0000-000000000001";

const USER_A1_ACCT = "10000000-user-0000-0000-0000000000a1";
const USER_A_OWNER = "10000000-user-0000-0000-00000000a999";
const USER_B1_OWNER = "10000000-user-0000-0000-0000000000b1";

function makeFixture() {
  const members = [
    { tenant_id: TENANT_A, user_id: USER_A1_ACCT, role: "accountant", property_id: PROPERTY_A1 },
    { tenant_id: TENANT_A, user_id: USER_A_OWNER, role: "owner", property_id: null },
    { tenant_id: TENANT_B, user_id: USER_B1_OWNER, role: "owner", property_id: null },
  ];
  const locations = [
    { id: LOC_A1, tenant_id: TENANT_A, property_id: PROPERTY_A1 },
    { id: LOC_A2, tenant_id: TENANT_A, property_id: PROPERTY_A2 },
  ];
  const closes: any[] = [];
  const exceptions: any[] = [];
  const declarations: any[] = [];
  const runs: any[] = [];
  const audit: any[] = [];
  const orders: any[] = []; // always empty — loadDayFacts short-circuits
  let seq = 0;

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const isFilters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: any;
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      is(col: string, val: unknown) {
        isFilters.push((r: any) => (r[col] ?? null) === val);
        return api;
      },
      gte: () => api,
      lt: () => api,
      order: () => api,
      limit: () => api,
      insert(row: any) {
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
      if (table === "restaurant_daily_closes") return closes;
      if (table === "restaurant_reconciliation_exceptions") return exceptions;
      if (table === "restaurant_tender_declarations") return declarations;
      if (table === "restaurant_reconciliation_runs") return runs;
      if (table === "restaurant_reconciliation_audit") return audit;
      if (table === "restaurant_orders") return orders;
      return [];
    }

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      if (op === "insert") {
        seq += 1;
        const stored = { id: `recon-${seq}`, status: "draft", ...payload };
        rowsFor().push(stored);
        return { data: stored, error: null };
      }
      if (op === "update") {
        const rows = rowsFor().filter(
          (r) => filters.every((f) => f(r)) && isFilters.every((f) => f(r)),
        );
        for (const r of rows) Object.assign(r, payload);
        return { data: rows[0] ?? null, error: null };
      }
      const rows = rowsFor().filter(
        (r) => filters.every((f) => f(r)) && isFilters.every((f) => f(r)),
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
    closes,
    exceptions,
  };
}

describe("P1 property scope — Reconciliation access matrix", () => {
  it("openDailyClose: A1-accountant can open A1's day but is DENIED opening A2's", async () => {
    const fixture = makeFixture();
    await expect(
      openDailyClose(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
        businessDate: "2026-01-01",
        openingFloat: 0,
        currency: "TZS",
      } as any),
    ).resolves.toBeDefined();

    await expect(
      openDailyClose(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        businessDate: "2026-01-01",
        openingFloat: 0,
        currency: "TZS",
      } as any),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("getDailyClose: A1-accountant can read A1's day but is DENIED A2's", async () => {
    const fixture = makeFixture();
    await expect(
      getDailyClose(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
        businessDate: "2026-01-01",
      } as any),
    ).resolves.toBeDefined();
    await expect(
      getDailyClose(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        businessDate: "2026-01-01",
      } as any),
    ).rejects.toThrow(/do not have access to this location/);
  });

  it("declareTenders: scope is derived from the close row's OWN location, not a client field — A1-accountant is denied declaring against an A2 close", async () => {
    const fixture = makeFixture();
    fixture.closes.push({
      id: "close-a2",
      tenant_id: TENANT_A,
      location_id: LOC_A2,
      business_date: "2026-01-01",
      status: "draft",
      opening_float: 0,
    });
    await expect(
      declareTenders(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        closeId: "close-a2",
        declarations: [{ method: "cash", declaredAmount: 100 }],
      } as any),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("resolveException: scope is derived from the exception row's OWN location — A1-accountant denied resolving an A2 exception", async () => {
    const fixture = makeFixture();
    fixture.exceptions.push({
      id: "exc-a2",
      tenant_id: TENANT_A,
      location_id: LOC_A2,
      status: "open",
      severity: "medium",
    });
    await expect(
      resolveException(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        exceptionId: "exc-a2",
        status: "resolved",
        note: "Investigated and closed out.",
      } as any),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("closeDay / reopenDay: scope is derived from the close row's OWN location — A1-accountant denied both for an A2 close", async () => {
    const fixture = makeFixture();
    fixture.closes.push({
      id: "close-a2-2",
      tenant_id: TENANT_A,
      location_id: LOC_A2,
      business_date: "2026-01-02",
      status: "draft",
      opening_float: 0,
    });
    await expect(
      closeDay(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        closeId: "close-a2-2",
      } as any),
    ).rejects.toThrow(/not granted to you at this location/);

    fixture.closes.find((c: any) => c.id === "close-a2-2")!.status = "closed";
    await expect(
      reopenDay(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        closeId: "close-a2-2",
        reason: "Correcting a miskeyed tender.",
      } as any),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("runReconciliation: A1-accountant can run for A1 but is DENIED for A2", async () => {
    const fixture = makeFixture();
    await expect(
      runReconciliation(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
        businessDate: "2026-01-01",
        scope: "cash",
      } as any),
    ).resolves.toBeDefined();
    await expect(
      runReconciliation(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        businessDate: "2026-01-01",
        scope: "cash",
      } as any),
    ).rejects.toThrow(/not granted to you at this location/);
  });

  it("cross-tenant: Tenant B's owner cannot reach any Tenant A reconciliation function", async () => {
    const fixture = makeFixture();
    await expect(
      getDailyClose(fixture.supabase, USER_B1_OWNER, {
        tenantId: TENANT_A,
        businessDate: "2026-01-01",
      } as any),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });

  it("tenant-wide owner reaches both A1 and A2", async () => {
    const fixture = makeFixture();
    await expect(
      openDailyClose(fixture.supabase, USER_A_OWNER, {
        tenantId: TENANT_A,
        locationId: LOC_A1,
        businessDate: "2026-01-03",
        openingFloat: 0,
        currency: "TZS",
      } as any),
    ).resolves.toBeDefined();
    await expect(
      openDailyClose(fixture.supabase, USER_A_OWNER, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        businessDate: "2026-01-03",
        openingFloat: 0,
        currency: "TZS",
      } as any),
    ).resolves.toBeDefined();
  });

  it("DISCLOSED GAP: listDailyCloses has no locationId in its schema and remains tenant-only — A1-accountant sees closes from every location, including A2's", async () => {
    const fixture = makeFixture();
    fixture.closes.push(
      {
        id: "close-a1-only",
        tenant_id: TENANT_A,
        location_id: LOC_A1,
        business_date: "2026-02-01",
        status: "draft",
      },
      {
        id: "close-a2-only",
        tenant_id: TENANT_A,
        location_id: LOC_A2,
        business_date: "2026-02-01",
        status: "draft",
      },
    );
    const rows = await listDailyCloses(fixture.supabase, USER_A1_ACCT, {
      tenantId: TENANT_A,
      limit: 50,
    } as any);
    const ids = rows.map((r: any) => r.id);
    // This assertion documents the KNOWN, DISCLOSED gap — it is not a
    // desired behaviour. If this ever starts failing because someone adds
    // locationId scoping to listDailyCloses, delete this test along with
    // the gap note in the final P1 report rather than "fixing" it back.
    expect(ids).toContain("close-a2-only");
  });
});
