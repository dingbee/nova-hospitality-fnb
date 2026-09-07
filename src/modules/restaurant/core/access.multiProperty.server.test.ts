/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P01 completion pass — "multi_property_command" is a registered, tiered
 * capability (core=unavailable, pro=limited, enterprise=enterprise/advanced
 * under Founding 10) with no runtime enforcement anywhere: any caller
 * holding a tenant-wide grant could aggregate across every property their
 * tenant has (Decisions Board, Staff Ask LexiBite) regardless of plan.
 * resolveMultiPropertyScope (access.server.ts) closes that gap; these tests
 * exercise it directly against a fake Supabase modeling exactly the tables
 * it and the commercial resolver it delegates to actually query (same
 * generic chainable-array-fake pattern as commercial.server.test.ts).
 */
import { describe, expect, it } from "vitest";
import { resolveMultiPropertyScope, type TenantScope } from "./access.server";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROPERTY_A1 = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const PROPERTY_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const CORE = "plan-core";
const CAP_MPC = "cap-multi-property-command";

const TENANT_WIDE_SCOPE: TenantScope = {
  tenantId: TENANT_A,
  platformAdmin: false,
  grants: [{ role: "owner", propertyId: null }],
};

function makeFixture(opts: {
  properties?: Array<{ id: string; tenant_id: string; created_at: string }>;
  entitled?: boolean;
}) {
  const properties = opts.properties ?? [];
  const capabilities = [{ id: CAP_MPC, code: "multi_property_command", status: "active" }];
  const plans = [{ id: CORE, code: "core" }];
  const planEntitlements = opts.entitled
    ? [
        {
          plan_id: CORE,
          capability_id: CAP_MPC,
          state: "limited",
          config: {},
          effective_from: new Date(Date.now() - 86_400_000).toISOString(),
          effective_until: null,
        },
      ]
    : [];

  function tableFor(name: string): any[] {
    switch (name) {
      case "restaurant_properties":
        return properties;
      case "commercial_plans":
        return plans;
      case "commercial_capabilities":
        return capabilities;
      case "commercial_plan_entitlements":
        return planEntitlements;
      default:
        return []; // commercial_programme_entitlements, commercial_overrides,
      // commercial_quota_definitions, restaurant_subscriptions — all
      // legitimately empty for this fixture (no programme, no override,
      // no quota configured, no subscription row → defaults to CORE).
    }
  }

  function from(table: string) {
    const predicates: Array<(r: any) => boolean> = [];
    let wantCount = false;
    const api: any = {
      select(_cols?: string, options?: { count?: string; head?: boolean }) {
        if (options?.count) wantCount = true;
        return api;
      },
      eq(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        predicates.push((r) => set.has(r[col]));
        return api;
      },
      lte: () => api,
      or: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };
    async function resolve(mode: "single" | "maybeSingle" | "list") {
      const rows = tableFor(table);
      const matches = rows.filter((r) => predicates.every((p) => p(r)));
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

  return { from } as any;
}

describe("resolveMultiPropertyScope", () => {
  it("a caller resolving to a specific property (property-scoped, or a tenant-wide caller who named one) never touches the commercial gate at all", async () => {
    const sb = makeFixture({ entitled: false });
    const scope: TenantScope = {
      tenantId: TENANT_A,
      platformAdmin: false,
      grants: [{ role: "owner", propertyId: PROPERTY_A1 }],
    };
    const result = await resolveMultiPropertyScope(sb, TENANT_A, scope, undefined);
    expect(result).toBe(PROPERTY_A1);
  });

  it("a tenant with only one property is never gated, even for a tenant-wide caller aggregating 'everything'", async () => {
    const sb = makeFixture({
      properties: [{ id: PROPERTY_A1, tenant_id: TENANT_A, created_at: "2024-01-01" }],
      entitled: false,
    });
    const result = await resolveMultiPropertyScope(sb, TENANT_A, TENANT_WIDE_SCOPE, undefined);
    expect(result).toBeUndefined();
  });

  it("an entitled tenant with multiple properties is permitted full cross-property aggregation", async () => {
    const sb = makeFixture({
      properties: [
        { id: PROPERTY_A1, tenant_id: TENANT_A, created_at: "2024-01-01" },
        { id: PROPERTY_A2, tenant_id: TENANT_A, created_at: "2024-02-01" },
      ],
      entitled: true,
    });
    const result = await resolveMultiPropertyScope(sb, TENANT_A, TENANT_WIDE_SCOPE, undefined);
    expect(result).toBeUndefined();
  });

  it("SECURITY: a non-entitled tenant with multiple properties is silently narrowed to its own first-created property, never aggregated across all of them", async () => {
    const sb = makeFixture({
      properties: [
        { id: PROPERTY_A1, tenant_id: TENANT_A, created_at: "2024-01-01" },
        { id: PROPERTY_A2, tenant_id: TENANT_A, created_at: "2024-02-01" },
      ],
      entitled: false,
    });
    const result = await resolveMultiPropertyScope(sb, TENANT_A, TENANT_WIDE_SCOPE, undefined);
    expect(result).toBe(PROPERTY_A1);
  });
});
