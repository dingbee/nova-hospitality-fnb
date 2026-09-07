/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P01 — commercial architecture unit tests.
 *
 * Follows this codebase's established in-memory fake-Supabase pattern
 * (see reconciliation.property-scope.test.ts) rather than mocking the
 * Supabase client directly: a tiny chainable query-builder fake backed by
 * plain arrays, generic enough to support the filters this module's
 * server functions actually issue (eq/is/in/lte/gt/or/order/limit/count/
 * upsert), so the tests exercise the real resolver/quota/classification
 * logic, not a re-implementation of it.
 */
import { describe, expect, it } from "vitest";
import { assertCommercialAdmin, isCommercialAdmin } from "./access.server";
import { classifyProperty } from "./property-classification.server";
import { checkQuota, incrementUsage, periodWindow, QuotaExceededError } from "./quota.server";
import { assertEntitled, CommercialEntitlementError, resolveEntitlement } from "./resolver.server";
import { PLAN_CODES } from "./contracts";

/* ---------------------------------------------------------------- fixture */

const CORE = "10000000-plan-0000-0000-000000000001";
const PRO = "10000000-plan-0000-0000-000000000002";
const ENTERPRISE = "10000000-plan-0000-0000-000000000003";
const FOUNDING_10 = "10000000-prog-0000-0000-000000000001";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROPERTY_A1 = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const PROPERTY_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const PROPERTY_A3 = "a3a3a3a3-a3a3-a3a3-a3a3-a3a3a3a3a3a3";
const USER_ADMIN = "10000000-user-0000-0000-00000000ad11";
const USER_REVOKED_ADMIN = "10000000-user-0000-0000-00000000ad22";
const USER_OWNER = "10000000-user-0000-0000-000000000001";

const CAP_MENU_INT = "20000000-cap0-0000-0000-000000000001";
const CAP_POS = "20000000-cap0-0000-0000-000000000002";
const CAP_DEPRECATED = "20000000-cap0-0000-0000-000000000003";
const CAP_NO_ENTITLEMENT = "20000000-cap0-0000-0000-000000000004";

function iso(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}

function makeFixture() {
  const administrators = [
    { id: "adm-1", user_id: USER_ADMIN, status: "active" },
    { id: "adm-2", user_id: USER_REVOKED_ADMIN, status: "revoked" },
  ];
  const plans = [
    { id: CORE, code: "core", status: "active" },
    { id: PRO, code: "pro", status: "active" },
    { id: ENTERPRISE, code: "enterprise", status: "active" },
  ];
  const programmes = [{ id: FOUNDING_10, code: "founding_10", status: "active" }];
  const capabilities = [
    { id: CAP_MENU_INT, code: "menu_intelligence", status: "active" },
    { id: CAP_POS, code: "pos", status: "active" },
    { id: CAP_DEPRECATED, code: "legacy_thing", status: "deprecated" },
    { id: CAP_NO_ENTITLEMENT, code: "orphan_capability", status: "active" },
  ];
  const planEntitlements = [
    {
      id: "pe-1",
      plan_id: CORE,
      capability_id: CAP_MENU_INT,
      state: "limited",
      config: {},
      effective_from: iso(-30),
      effective_until: null,
    },
    {
      id: "pe-2",
      plan_id: PRO,
      capability_id: CAP_MENU_INT,
      state: "advanced",
      config: {},
      effective_from: iso(-30),
      effective_until: null,
    },
    {
      id: "pe-3",
      plan_id: CORE,
      capability_id: CAP_POS,
      state: "included",
      config: {},
      effective_from: iso(-30),
      effective_until: null,
    },
  ];
  const programmeEntitlements = [
    {
      id: "pge-1",
      programme_id: FOUNDING_10,
      capability_id: CAP_MENU_INT,
      state: "enterprise",
      config: {},
    },
  ];
  const propertyPolicies = [
    {
      id: "pp-core",
      plan_id: CORE,
      programme_id: null,
      included_properties: 1,
      additional_property_price: 250000,
      property_limit: null,
      requires_approval_above: 2,
      enterprise_treatment: false,
      status: "active",
      effective_from: iso(-30),
      effective_until: null,
    },
    {
      id: "pp-pro-noprice",
      plan_id: PRO,
      programme_id: null,
      included_properties: 2,
      additional_property_price: null,
      property_limit: null,
      requires_approval_above: null,
      enterprise_treatment: false,
      status: "active",
      effective_from: iso(-30),
      effective_until: null,
    },
  ];
  const quotaDefinitions = [
    {
      id: "q-core",
      code: "ai_requests_monthly",
      capability_id: CAP_MENU_INT,
      plan_id: CORE,
      programme_id: null,
      unit: "ai_requests",
      limit_value: 20,
      period: "month",
      scope: "tenant",
      warning_threshold_pct: 80,
      near_limit_threshold_pct: 95,
      overage_behavior: "block",
      active: true,
      effective_from: iso(-30),
      effective_until: null,
    },
    {
      id: "q-pro-notify",
      code: "notify_quota",
      capability_id: null,
      plan_id: PRO,
      programme_id: null,
      unit: "count",
      limit_value: 10,
      period: "month",
      scope: "tenant",
      warning_threshold_pct: 80,
      near_limit_threshold_pct: 95,
      overage_behavior: "notify_admin",
      active: true,
      effective_from: iso(-30),
      effective_until: null,
    },
  ];
  const usageCounters: any[] = [];
  const overrides: any[] = [];
  const propertyClassifications: any[] = [];
  const auditLog: any[] = [];
  const subscriptions: any[] = [];

  function tableFor(name: string): any[] {
    switch (name) {
      case "commercial_administrators":
        return administrators;
      case "commercial_plans":
        return plans;
      case "commercial_programmes":
        return programmes;
      case "commercial_capabilities":
        return capabilities;
      case "commercial_plan_entitlements":
        return planEntitlements;
      case "commercial_programme_entitlements":
        return programmeEntitlements;
      case "commercial_property_policies":
        return propertyPolicies;
      case "commercial_quota_definitions":
        return quotaDefinitions;
      case "commercial_usage_counters":
        return usageCounters;
      case "commercial_overrides":
        return overrides;
      case "commercial_property_classifications":
        return propertyClassifications;
      case "commercial_audit_log":
        return auditLog;
      case "restaurant_subscriptions":
        return subscriptions;
      default:
        return [];
    }
  }

  function parseOrExpr(expr: string) {
    const clauses = expr.split(",");
    return (r: any) =>
      clauses.some((c) => {
        const [field, op, ...rest] = c.split(".");
        const raw = rest.join(".");
        const rowVal = r[field!] ?? null;
        if (op === "is") return raw === "null" ? rowVal === null : String(rowVal) === raw;
        if (op === "eq") return rowVal !== null && String(rowVal) === raw;
        if (op === "gt") return rowVal !== null && String(rowVal) > raw;
        if (op === "gte") return rowVal !== null && String(rowVal) >= raw;
        if (op === "lt") return rowVal !== null && String(rowVal) < raw;
        if (op === "lte") return rowVal !== null && String(rowVal) <= raw;
        return false;
      });
  }

  function from(table: string) {
    const predicates: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" | "upsert" = "select";
    let payload: any;
    let upsertConflictCol: string | undefined;
    let wantCount = false;
    let seq = 0;
    const api: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) wantCount = true;
        return api;
      },
      eq(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return api;
      },
      is(col: string, val: unknown) {
        predicates.push((r) => (r[col] ?? null) === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        predicates.push((r) => set.has(r[col]));
        return api;
      },
      or(expr: string) {
        predicates.push(parseOrExpr(expr));
        return api;
      },
      lte(col: string, val: unknown) {
        predicates.push((r) => r[col] != null && String(r[col]) <= String(val));
        return api;
      },
      lt(col: string, val: unknown) {
        predicates.push((r) => r[col] != null && String(r[col]) < String(val));
        return api;
      },
      gt(col: string, val: unknown) {
        predicates.push((r) => r[col] != null && String(r[col]) > String(val));
        return api;
      },
      gte(col: string, val: unknown) {
        predicates.push((r) => r[col] != null && String(r[col]) >= String(val));
        return api;
      },
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
      upsert(row: any, opts?: { onConflict?: string }) {
        op = "upsert";
        payload = row;
        upsertConflictCol = opts?.onConflict;
        return api;
      },
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      const rows = tableFor(table);
      if (op === "insert") {
        seq += 1;
        const stored = { id: `${table}-${Date.now()}-${seq}`, ...payload };
        rows.push(stored);
        return { data: stored, error: null };
      }
      if (op === "upsert") {
        const existing = upsertConflictCol
          ? rows.find((r) => r[upsertConflictCol!] === payload[upsertConflictCol!])
          : undefined;
        if (existing) {
          Object.assign(existing, payload);
          return { data: existing, error: null };
        }
        seq += 1;
        const stored = { id: `${table}-${Date.now()}-${seq}`, ...payload };
        rows.push(stored);
        return { data: stored, error: null };
      }
      const matches = rows.filter((r) => predicates.every((p) => p(r)));
      if (op === "update") {
        for (const r of matches) Object.assign(r, payload);
        return { data: matches[0] ?? null, error: null };
      }
      if (mode === "list") {
        const result: any = { data: matches, error: null };
        if (wantCount) result.count = matches.length;
        return result;
      }
      return {
        data: matches[0] ?? null,
        error: mode === "single" && !matches[0] ? { message: "not found" } : null,
      };
    }
    return api;
  }

  return {
    supabase: {
      from,
      rpc: async (fn: string, params: any) => {
        if (fn === "restaurant_is_commercial_admin") {
          const isAdmin = administrators.some(
            (a) => a.user_id === params._user_id && a.status === "active",
          );
          return { data: isAdmin, error: null };
        }
        return { data: null, error: null };
      },
    },
    plans,
    programmes,
    capabilities,
    planEntitlements,
    programmeEntitlements,
    propertyPolicies,
    quotaDefinitions,
    usageCounters,
    overrides,
    propertyClassifications,
    auditLog,
    subscriptions,
  };
}

/* --------------------------------------------------------- periodWindow */

describe("periodWindow", () => {
  it("computes a calendar month window", () => {
    const { start, end } = periodWindow("month", new Date("2026-03-15T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("computes a calendar day window", () => {
    const { start, end } = periodWindow("day", new Date("2026-03-15T18:00:00Z"));
    expect(start.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-16T00:00:00.000Z");
  });

  it("computes a calendar year window", () => {
    const { start, end } = periodWindow("year", new Date("2026-07-01T00:00:00Z"));
    expect(start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("falls back billing_cycle to the calendar month (no billing engine to anchor to)", () => {
    const month = periodWindow("month", new Date("2026-05-10T00:00:00Z"));
    const cycle = periodWindow("billing_cycle", new Date("2026-05-10T00:00:00Z"));
    expect(cycle.start.toISOString()).toBe(month.start.toISOString());
  });
});

/* --------------------------------------------------- commercial admin gate */

describe("commercial admin gate", () => {
  it("active administrator passes, revoked administrator and stranger are denied", async () => {
    const { supabase } = makeFixture();
    expect(await isCommercialAdmin(supabase, USER_ADMIN)).toBe(true);
    expect(await isCommercialAdmin(supabase, USER_REVOKED_ADMIN)).toBe(false);
    expect(await isCommercialAdmin(supabase, USER_OWNER)).toBe(false);

    await expect(assertCommercialAdmin(supabase, USER_ADMIN)).resolves.toBeUndefined();
    await expect(assertCommercialAdmin(supabase, USER_OWNER)).rejects.toThrow(/platform-level/);
  });
});

/* --------------------------------------------------------- resolveEntitlement */

describe("resolveEntitlement", () => {
  it("resolves the plan baseline when no subscription row exists (defaults to CORE)", async () => {
    const { supabase } = makeFixture();
    const result = await resolveEntitlement(supabase, TENANT_A, "menu_intelligence");
    expect(result.planCode).toBe("core");
    expect(result.state).toBe("limited");
    expect(result.source).toBe("plan");
  });

  it("resolves a higher plan's baseline when a subscription is on record", async () => {
    const fx = makeFixture();
    fx.subscriptions.push({
      id: "sub-a",
      tenant_id: TENANT_A,
      status: "active",
      billing_interval: "monthly",
      plan_id: PRO,
      programme_id: null,
      commercial_plans: { id: PRO, code: "pro" },
      commercial_programmes: null,
    });
    const result = await resolveEntitlement(fx.supabase, TENANT_A, "menu_intelligence");
    expect(result.planCode).toBe("pro");
    expect(result.state).toBe("advanced");
    expect(result.source).toBe("plan");
  });

  it("Founding 10 programme entitlement overrides the plan baseline — without ever being a fourth plan", async () => {
    const fx = makeFixture();
    fx.subscriptions.push({
      id: "sub-a",
      tenant_id: TENANT_A,
      status: "active",
      billing_interval: "monthly",
      plan_id: PRO,
      programme_id: FOUNDING_10,
      commercial_plans: { id: PRO, code: "pro" },
      commercial_programmes: { id: FOUNDING_10, code: "founding_10", status: "active" },
    });
    const result = await resolveEntitlement(fx.supabase, TENANT_A, "menu_intelligence");
    expect(result.planCode).toBe("pro");
    expect(result.programmeCode).toBe("founding_10");
    expect(result.state).toBe("enterprise");
    expect(result.source).toBe("programme");
    // Founding 10 is a programme overlay on a real plan, never its own plan code.
    expect(PLAN_CODES).toHaveLength(3);
    expect(PLAN_CODES).not.toContain("founding_10");
  });

  it("an active commercial override wins over both plan and programme", async () => {
    const fx = makeFixture();
    fx.overrides.push({
      id: "ov-1",
      scope_type: "capability",
      scope_id: CAP_MENU_INT,
      tenant_id: null,
      payload: { state: "coming_soon" },
      status: "active",
      effective_from: iso(-1),
      effective_until: null,
    });
    const result = await resolveEntitlement(fx.supabase, TENANT_A, "menu_intelligence");
    expect(result.state).toBe("coming_soon");
    expect(result.source).toBe("override");
  });

  it("a deprecated capability is forced unavailable regardless of any entitlement row", async () => {
    const { supabase } = makeFixture();
    const result = await resolveEntitlement(supabase, TENANT_A, "legacy_thing");
    expect(result.state).toBe("unavailable");
  });

  it("a capability with no plan entitlement row defaults to unavailable, never included", async () => {
    const { supabase } = makeFixture();
    const result = await resolveEntitlement(supabase, TENANT_A, "orphan_capability");
    expect(result.state).toBe("unavailable");
    expect(result.source).toBe("default");
  });

  it("a nonexistent capability code resolves to unavailable", async () => {
    const { supabase } = makeFixture();
    const result = await resolveEntitlement(supabase, TENANT_A, "totally_made_up");
    expect(result.state).toBe("unavailable");
    expect(result.capabilityStatus).toBe("unknown");
  });

  it("assertEntitled throws CommercialEntitlementError for an unavailable capability and passes for an included one", async () => {
    const { supabase } = makeFixture();
    await expect(assertEntitled(supabase, TENANT_A, "orphan_capability")).rejects.toBeInstanceOf(
      CommercialEntitlementError,
    );
    await expect(assertEntitled(supabase, TENANT_A, "pos")).resolves.toMatchObject({
      state: "included",
    });
  });
});

/* ------------------------------------------------------------------ quotas */

describe("quota engine", () => {
  it("an unconfigured quota code is unmetered — checkQuota returns null and increments are always allowed", async () => {
    const { supabase } = makeFixture();
    expect(await checkQuota(supabase, TENANT_A, "no_such_quota")).toBeNull();
    expect(await incrementUsage(supabase, TENANT_A, "no_such_quota")).toBeNull();
  });

  it("moves NORMAL -> WARNING -> NEAR_LIMIT -> BLOCKED as usage crosses admin-configured thresholds", async () => {
    const fx = makeFixture();
    fx.subscriptions.push({
      id: "sub-a",
      tenant_id: TENANT_A,
      status: "active",
      billing_interval: "monthly",
      plan_id: CORE,
      programme_id: null,
      commercial_plans: { id: CORE, code: "core" },
      commercial_programmes: null,
    });
    // limit=20, warning=80% (16), near_limit=95% (19)
    let status = await incrementUsage(fx.supabase, TENANT_A, "ai_requests_monthly", { amount: 14 });
    expect(status?.state).toBe("NORMAL"); // 14/20 = 70%

    status = await incrementUsage(fx.supabase, TENANT_A, "ai_requests_monthly", { amount: 2 });
    expect(status?.state).toBe("WARNING"); // 16/20 = 80%

    status = await incrementUsage(fx.supabase, TENANT_A, "ai_requests_monthly", { amount: 3 });
    expect(status?.state).toBe("NEAR_LIMIT"); // 19/20 = 95%

    status = await incrementUsage(fx.supabase, TENANT_A, "ai_requests_monthly", { amount: 1 });
    expect(status?.state).toBe("BLOCKED"); // 20/20 = 100%, overage_behavior=block

    await expect(
      incrementUsage(fx.supabase, TENANT_A, "ai_requests_monthly", { amount: 1 }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("overage_behavior other than 'block' reaches LIMIT_REACHED but does not throw", async () => {
    const fx = makeFixture();
    fx.subscriptions.push({
      id: "sub-a",
      tenant_id: TENANT_A,
      status: "active",
      billing_interval: "monthly",
      plan_id: PRO,
      programme_id: null,
      commercial_plans: { id: PRO, code: "pro" },
      commercial_programmes: null,
    });
    const status = await incrementUsage(fx.supabase, TENANT_A, "notify_quota", { amount: 10 });
    expect(status?.state).toBe("LIMIT_REACHED");
    await expect(
      incrementUsage(fx.supabase, TENANT_A, "notify_quota", { amount: 1 }),
    ).resolves.toMatchObject({ state: "LIMIT_REACHED" });
  });

  it("an active quota override bypasses the block even past 100% usage", async () => {
    const fx = makeFixture();
    fx.subscriptions.push({
      id: "sub-a",
      tenant_id: TENANT_A,
      status: "active",
      billing_interval: "monthly",
      plan_id: CORE,
      programme_id: null,
      commercial_plans: { id: CORE, code: "core" },
      commercial_programmes: null,
    });
    fx.overrides.push({
      id: "ov-quota",
      scope_type: "quota",
      scope_id: "q-core",
      tenant_id: null,
      payload: { bypass: true },
      status: "active",
      effective_from: iso(-1),
      effective_until: null,
    });
    const status = await incrementUsage(fx.supabase, TENANT_A, "ai_requests_monthly", {
      amount: 50,
    });
    expect(status?.state).toBe("OVERRIDE");
  });
});

/* ------------------------------------------------------ property classification */

describe("classifyProperty", () => {
  it("the first property for a tenant is always 'base', never chargeable", async () => {
    const { supabase } = makeFixture();
    const result = await classifyProperty(supabase, USER_OWNER, TENANT_A, PROPERTY_A1);
    expect(result.classification).toBe("base");
    expect(result.chargeable).toBe(false);
    expect(result.propertySequence).toBe(1);
  });

  it("a second property beyond the CORE plan's included allowance is chargeable at the configured price", async () => {
    const fx = makeFixture();
    // CORE policy: included_properties = 1, so the 2nd property exceeds the allowance.
    await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A1);
    const second = await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A2);
    expect(second.classification).toBe("additional_chargeable");
    expect(second.chargeable).toBe(true);
    expect(second.priceApplied).toBe(250000);
    expect(second.propertySequence).toBe(2);
  });

  it("never silently activates a charge: a plan with a configured price above the allowance is chargeable and audited", async () => {
    const fx = makeFixture();
    await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A1);
    await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A2);
    const auditEntries = fx.auditLog.filter((a) => a.action === "property.classify");
    expect(auditEntries).toHaveLength(2);
    expect(auditEntries[1].after.chargeable).toBe(true);
  });

  it("a plan with an included allowance but no configured additional-property price never fabricates a charge", async () => {
    const fx = makeFixture();
    fx.subscriptions.push({
      id: "sub-pro",
      tenant_id: TENANT_A,
      status: "active",
      billing_interval: "monthly",
      plan_id: PRO,
      programme_id: null,
      commercial_plans: { id: PRO, code: "pro" },
      commercial_programmes: null,
    });
    // PRO policy: included_properties = 2, no additional_property_price configured.
    await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A1);
    await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A2);
    const third = await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A3);
    expect(third.classification).toBe("additional_included");
    expect(third.chargeable).toBe(false);
    expect(third.notes).toMatch(/no additional-property price is configured/i);
  });

  it("a property within a plan's included allowance (but not the first) is classified 'included', non-chargeable", async () => {
    const fx = makeFixture();
    fx.subscriptions.push({
      id: "sub-pro",
      tenant_id: TENANT_A,
      status: "active",
      billing_interval: "monthly",
      plan_id: PRO,
      programme_id: null,
      commercial_plans: { id: PRO, code: "pro" },
      commercial_programmes: null,
    });
    // PRO policy: included_properties = 2.
    const first = await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A1);
    const second = await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A2);
    expect(first.classification).toBe("base");
    expect(second.classification).toBe("included");
    expect(second.chargeable).toBe(false);
  });

  it("an explicit property override wins and is recorded as override_covered", async () => {
    const fx = makeFixture();
    await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A1);
    fx.overrides.push({
      id: "ov-prop",
      scope_type: "property",
      scope_id: PROPERTY_A2,
      tenant_id: TENANT_A,
      payload: { chargeable: false },
      reason: "Negotiated waiver",
      status: "active",
      effective_from: iso(-1),
      effective_until: null,
    });
    const result = await classifyProperty(fx.supabase, USER_OWNER, TENANT_A, PROPERTY_A2);
    expect(result.classification).toBe("override_covered");
    expect(result.chargeable).toBe(false);
  });
});
