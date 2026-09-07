/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * GEP4 — upsertBusinessProfile must never silently drop a configured logo.
 * logoUrl is exclusively managed by tenant-logo.server.ts's upload/remove
 * functions; this form only ever touches the text fields, so a save here
 * must carry any existing logoUrl forward unchanged.
 */
import { describe, expect, it } from "vitest";
import { upsertBusinessProfile, upsertProperty } from "./masterdata.server";

const TENANT = "tenant-1";
const OWNER = "user-owner";

function makeFakeSupabase(initialSettings: any) {
  const tenant = { id: TENANT, settings: initialSettings };
  const members = [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }];

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "update" = "select";
    let payload: any;
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      single: async () => {
        if (table === "restaurant_tenants") {
          if (op === "update") Object.assign(tenant, payload);
          return { data: tenant, error: null };
        }
        return { data: null, error: { message: "not found" } };
      },
      then: (resolve: (v: { data: any }) => unknown) => {
        if (table === "restaurant_members") return resolve({ data: members });
        return resolve({ data: [] });
      },
    };
    return api;
  }

  function rpc() {
    return Promise.resolve({ data: false, error: null });
  }

  return { from, rpc, tenant } as any;
}

describe("upsertBusinessProfile", () => {
  it("preserves an existing logoUrl when only the text fields are saved", async () => {
    const sb = makeFakeSupabase({
      business: { legalName: "Old Ltd", logoUrl: "https://cdn.example/logos/tenant-1/1.png" },
    });
    const result = await upsertBusinessProfile(sb, OWNER, {
      tenantId: TENANT,
      legalName: "New Name Ltd",
      tradingName: "New Trading Name",
      defaultCurrency: "TZS",
      timezone: "Africa/Dar_es_Salaam",
    });
    expect((result as any).settings.business.logoUrl).toBe(
      "https://cdn.example/logos/tenant-1/1.png",
    );
    expect((result as any).settings.business.legalName).toBe("New Name Ltd");
    expect((result as any).settings.business.tradingName).toBe("New Trading Name");
  });

  it("leaves logoUrl null when the tenant never had one configured — never fabricates a value", async () => {
    const sb = makeFakeSupabase({});
    const result = await upsertBusinessProfile(sb, OWNER, {
      tenantId: TENANT,
      legalName: "Demo Ltd",
      defaultCurrency: "TZS",
      timezone: "Africa/Dar_es_Salaam",
    });
    expect((result as any).settings.business.logoUrl).toBeNull();
  });

  it("also preserves other sibling settings (tax, service_charge_percent) untouched by this form", async () => {
    const sb = makeFakeSupabase({
      tax: { vat_percent: 18 },
      service_charge_percent: 10,
      business: { legalName: "Old Ltd" },
    });
    const result = await upsertBusinessProfile(sb, OWNER, {
      tenantId: TENANT,
      legalName: "New Ltd",
      defaultCurrency: "TZS",
      timezone: "Africa/Dar_es_Salaam",
    });
    expect((result as any).settings.tax.vat_percent).toBe(18);
    expect((result as any).settings.service_charge_percent).toBe(10);
  });
});

/**
 * P01 — every NEW property must pass through the commercial classification
 * engine exactly once (never on update), and the classification must never
 * be silently skipped even when no commercial policy has been configured
 * yet for the tenant's plan.
 */
function makeFakeSupabaseForProperty() {
  const tables: Record<string, any[]> = {
    restaurant_members: [{ tenant_id: TENANT, user_id: OWNER, role: "owner", property_id: null }],
    restaurant_properties: [],
    restaurant_subscriptions: [],
    commercial_plans: [{ id: "plan-core", code: "core" }],
    commercial_property_policies: [],
    commercial_property_classifications: [],
    commercial_overrides: [],
    commercial_audit_log: [],
  };

  function from(table: string) {
    const predicates: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: any;
    let wantCount = false;
    const api: any = {
      select(_cols?: string, opts?: { count?: string }) {
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
      or: () => api,
      lte: () => api,
      order: () => api,
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
    async function resolve(mode: "single" | "maybeSingle" | "list") {
      const rows = tables[table] ?? (tables[table] = []);
      if (op === "insert") {
        const stored = { id: `${table}-${rows.length + 1}`, ...payload };
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
      return { data: matches[0] ?? null, error: mode === "single" && !matches[0] ? { message: "not found" } : null };
    }
    return api;
  }

  return {
    from,
    rpc: async () => ({ data: false, error: null }),
    tables,
  } as any;
}

describe("upsertProperty — P01 commercial classification wiring", () => {
  it("classifies a brand-new property as 'base', non-chargeable, and writes an audit entry", async () => {
    const sb = makeFakeSupabaseForProperty();
    const result = await upsertProperty(sb, OWNER, {
      tenantId: TENANT,
      name: "Flagship",
      slug: "flagship",
      timezone: "Africa/Dar_es_Salaam",
      currency: "TZS",
      status: "active",
    } as any);
    expect((result as any).commercial).toMatchObject({ classification: "base", chargeable: false });
    expect(sb.tables.commercial_property_classifications).toHaveLength(1);
    expect(sb.tables.commercial_audit_log).toHaveLength(1);
  });

  it("never fabricates a charge when no property policy is configured for the plan", async () => {
    const sb = makeFakeSupabaseForProperty();
    await upsertProperty(sb, OWNER, {
      tenantId: TENANT,
      name: "Flagship",
      slug: "flagship",
      timezone: "Africa/Dar_es_Salaam",
      currency: "TZS",
      status: "active",
    } as any);
    const second = await upsertProperty(sb, OWNER, {
      tenantId: TENANT,
      name: "Second Site",
      slug: "second-site",
      timezone: "Africa/Dar_es_Salaam",
      currency: "TZS",
      status: "active",
    } as any);
    expect((second as any).commercial).toMatchObject({
      classification: "additional_included",
      chargeable: false,
    });
  });

  it("never re-runs classification on an update — commercial stays null", async () => {
    const sb = makeFakeSupabaseForProperty();
    const created = await upsertProperty(sb, OWNER, {
      tenantId: TENANT,
      name: "Flagship",
      slug: "flagship",
      timezone: "Africa/Dar_es_Salaam",
      currency: "TZS",
      status: "active",
    } as any);
    const updated = await upsertProperty(sb, OWNER, {
      id: (created as any).id,
      tenantId: TENANT,
      name: "Flagship Renamed",
      slug: "flagship",
      timezone: "Africa/Dar_es_Salaam",
      currency: "TZS",
      status: "active",
    } as any);
    expect((updated as any).commercial).toBeNull();
    expect(sb.tables.commercial_property_classifications).toHaveLength(1);
  });
});
