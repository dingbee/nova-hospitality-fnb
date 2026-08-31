/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * GEP4 — upsertBusinessProfile must never silently drop a configured logo.
 * logoUrl is exclusively managed by tenant-logo.server.ts's upload/remove
 * functions; this form only ever touches the text fields, so a save here
 * must carry any existing logoUrl forward unchanged.
 */
import { describe, expect, it } from "vitest";
import { upsertBusinessProfile } from "./masterdata.server";

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
