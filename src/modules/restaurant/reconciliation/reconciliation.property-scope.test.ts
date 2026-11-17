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
 * FINAL CLOSURE: listDailyCloses, listExceptions, exceptionTrends and
 * listReconciliationAudit previously had no locationId in their Zod
 * schemas and were tenant-only. All four now accept an optional
 * locationId (rejected server-side via assertTenantRead if the caller
 * doesn't hold it) and, when omitted, restrict a property-scoped caller to
 * their own accessible locations via accessibleLocationIds — a
 * tenant-wide caller's behaviour is unchanged. The tests below prove that
 * closure directly; see reconciliation.server.ts's own comments for why
 * restaurant_reconciliation_audit (no location_id of its own) resolves
 * scope by joining to whichever of daily_closes/reconciliation_runs/
 * reconciliation_exceptions its subject_id actually points at.
 */
import { describe, expect, it } from "vitest";
import {
  closeDay,
  declareTenders,
  exceptionTrends,
  getDailyClose,
  listDailyCloses,
  listExceptions,
  listReconciliationAudit,
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
    const inFilters: Array<(r: any) => boolean> = [];
    const orFilters: Array<(r: any) => boolean> = [];
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
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        inFilters.push((r: any) => set.has(r[col]));
        return api;
      },
      /**
       * Only ever called by this codebase as
       * `.or("location_id.is.null,location_id.in.(id1,id2)")` — a tiny,
       * literal parser for exactly that shape, not a general PostgREST
       * filter-string interpreter.
       */
      or(expr: string) {
        const clauses = expr.split(",location_id.in.(");
        const isNullClause = clauses[0] === "location_id.is.null";
        const idList =
          clauses[1] !== undefined ? clauses[1].replace(/\)$/, "").split(",").filter(Boolean) : [];
        const idSet = new Set(idList);
        orFilters.push(
          (r: any) =>
            (isNullClause && (r.location_id ?? null) === null) || idSet.has(r.location_id),
        );
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
      const matches = (r: any) =>
        filters.every((f) => f(r)) &&
        isFilters.every((f) => f(r)) &&
        inFilters.every((f) => f(r)) &&
        orFilters.every((f) => f(r));
      if (op === "update") {
        const rows = rowsFor().filter(matches);
        for (const r of rows) Object.assign(r, payload);
        return { data: rows[0] ?? null, error: null };
      }
      const rows = rowsFor().filter(matches);
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
    runs,
    audit,
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

  it("CLOSED: listDailyCloses scopes to the caller's own location when none is named — A1-accountant no longer sees A2's close", async () => {
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
      {
        id: "close-tenant-wide",
        tenant_id: TENANT_A,
        location_id: null,
        business_date: "2026-02-01",
        status: "draft",
      },
    );
    const rows = await listDailyCloses(fixture.supabase, USER_A1_ACCT, {
      tenantId: TENANT_A,
      limit: 50,
    } as any);
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain("close-a1-only");
    expect(ids).not.toContain("close-a2-only");
    // A close with no location of its own is tenant-wide by the same
    // convention restaurant_can_read_scoped uses elsewhere — still visible
    // to a property-scoped member, just never another property's own.
    expect(ids).toContain("close-tenant-wide");

    const ownerRows = await listDailyCloses(fixture.supabase, USER_A_OWNER, {
      tenantId: TENANT_A,
      limit: 50,
    } as any);
    expect(ownerRows.map((r: any) => r.id)).toEqual(
      expect.arrayContaining(["close-a1-only", "close-a2-only", "close-tenant-wide"]),
    );
  });

  it("CLOSED: listDailyCloses rejects an explicit locationId the caller does not hold", async () => {
    const fixture = makeFixture();
    await expect(
      listDailyCloses(fixture.supabase, USER_A1_ACCT, {
        tenantId: TENANT_A,
        locationId: LOC_A2,
        limit: 50,
      } as any),
    ).rejects.toThrow(/do not have access to this location/);
  });

  it("CLOSED: listExceptions scopes to the caller's own location — A1-accountant no longer sees A2's exception", async () => {
    const fixture = makeFixture();
    fixture.exceptions.push(
      {
        id: "exc-a1",
        tenant_id: TENANT_A,
        location_id: LOC_A1,
        status: "open",
        severity: "medium",
        business_date: "2026-02-01",
      },
      {
        id: "exc-a2",
        tenant_id: TENANT_A,
        location_id: LOC_A2,
        status: "open",
        severity: "medium",
        business_date: "2026-02-01",
      },
    );
    const { rows } = await listExceptions(fixture.supabase, USER_A1_ACCT, {
      tenantId: TENANT_A,
      onlyOpen: false,
      limit: 50,
    } as any);
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain("exc-a1");
    expect(ids).not.toContain("exc-a2");
  });

  it("CLOSED: exceptionTrends scopes to the caller's own location — A1-accountant's totals exclude A2's exception", async () => {
    const fixture = makeFixture();
    const today = new Date().toISOString().slice(0, 10);
    fixture.exceptions.push(
      {
        id: "trend-a1",
        tenant_id: TENANT_A,
        location_id: LOC_A1,
        status: "open",
        code: "X",
        domain: "cash",
        impact_value: 10,
        business_date: today,
      },
      {
        id: "trend-a2",
        tenant_id: TENANT_A,
        location_id: LOC_A2,
        status: "open",
        code: "X",
        domain: "cash",
        impact_value: 1000,
        business_date: today,
      },
    );
    const a1 = await exceptionTrends(fixture.supabase, USER_A1_ACCT, {
      tenantId: TENANT_A,
      days: 30,
    } as any);
    expect(a1.total).toBe(1);
    expect(a1.impactValue).toBe(10);

    const owner = await exceptionTrends(fixture.supabase, USER_A_OWNER, {
      tenantId: TENANT_A,
      days: 30,
    } as any);
    expect(owner.total).toBe(2);
  });

  it("CLOSED: listReconciliationAudit resolves scope through the polymorphic subject (daily_close/run/exception) — A1-accountant no longer sees A2's audit entries", async () => {
    const fixture = makeFixture();
    fixture.closes.push({
      id: "audit-close-a2",
      tenant_id: TENANT_A,
      location_id: LOC_A2,
      business_date: "2026-02-01",
      status: "draft",
    });
    fixture.exceptions.push({
      id: "audit-exc-a1",
      tenant_id: TENANT_A,
      location_id: LOC_A1,
      status: "open",
      severity: "medium",
    });
    fixture.audit.push(
      {
        id: "audit-1",
        tenant_id: TENANT_A,
        subject_type: "daily_close",
        subject_id: "audit-close-a2",
        action: "close.opened",
      },
      {
        id: "audit-2",
        tenant_id: TENANT_A,
        subject_type: "reconciliation_exception",
        subject_id: "audit-exc-a1",
        action: "exception.status_changed",
      },
    );
    const rows = await listReconciliationAudit(fixture.supabase, USER_A1_ACCT, {
      tenantId: TENANT_A,
      limit: 50,
    } as any);
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain("audit-2");
    expect(ids).not.toContain("audit-1");

    const ownerRows = await listReconciliationAudit(fixture.supabase, USER_A_OWNER, {
      tenantId: TENANT_A,
      limit: 50,
    } as any);
    expect(ownerRows.map((r: any) => r.id)).toEqual(expect.arrayContaining(["audit-1", "audit-2"]));
  });

  it("cross-tenant: Tenant B's owner cannot list Tenant A's reconciliation data via any of the four scoped read functions", async () => {
    const fixture = makeFixture();
    await expect(
      listDailyCloses(fixture.supabase, USER_B1_OWNER, { tenantId: TENANT_A, limit: 50 } as any),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
    await expect(
      listExceptions(fixture.supabase, USER_B1_OWNER, {
        tenantId: TENANT_A,
        onlyOpen: false,
        limit: 50,
      } as any),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
    await expect(
      exceptionTrends(fixture.supabase, USER_B1_OWNER, { tenantId: TENANT_A, days: 30 } as any),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
    await expect(
      listReconciliationAudit(fixture.supabase, USER_B1_OWNER, {
        tenantId: TENANT_A,
        limit: 50,
      } as any),
    ).rejects.toThrow(/do not belong to this restaurant tenant/);
  });

  it("direct resource-ID manipulation: a property-scoped caller cannot read another property's exception by guessing its id via subjectId", async () => {
    const fixture = makeFixture();
    fixture.exceptions.push({
      id: "exc-a2-guess",
      tenant_id: TENANT_A,
      location_id: LOC_A2,
      status: "open",
      severity: "medium",
    });
    fixture.audit.push({
      id: "audit-guess",
      tenant_id: TENANT_A,
      subject_type: "reconciliation_exception",
      subject_id: "exc-a2-guess",
      action: "exception.status_changed",
    });
    const rows = await listReconciliationAudit(fixture.supabase, USER_A1_ACCT, {
      tenantId: TENANT_A,
      subjectId: "exc-a2-guess",
      limit: 50,
    } as any);
    // subjectId narrows the query but never bypasses location scoping —
    // the entry belongs to A2, which A1-accountant does not hold.
    expect(rows.map((r: any) => r.id)).not.toContain("audit-guess");
  });
});
