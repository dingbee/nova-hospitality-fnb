/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P13 readiness engine tests.
 *
 * `computeReadiness` reads ~15 tables in parallel and calls into
 * `pricingReadiness` (mocked here — it has its own dedicated test coverage
 * elsewhere; this suite is about the readiness *rollup*, not price
 * resolution). `assertTenantRead`/`assertCapability`/`getTenantScope` are
 * mocked the same way every other module in this codebase mocks them —
 * exercising the real security boundary is P11/security-review territory,
 * covered separately in readiness.security.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const assertTenantReadMock = vi.fn();
const assertCapabilityMock = vi.fn();
const getTenantScopeMock = vi.fn();
vi.mock("../core/access.server", () => ({
  assertTenantRead: (...args: unknown[]) => assertTenantReadMock(...args),
  assertCapability: (...args: unknown[]) => assertCapabilityMock(...args),
  getTenantScope: (...args: unknown[]) => getTenantScopeMock(...args),
}));

const pricingReadinessMock = vi.fn();
vi.mock("../pricing/readiness.server", () => ({
  pricingReadiness: (...args: unknown[]) => pricingReadinessMock(...args),
}));

const { computeReadiness, confirmGoLive } = await import("./readiness.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const OWNER = "22222222-2222-2222-2222-222222222222";

type Table = Record<string, any[]>;

/** A minimal Supabase fake: every `.from(table)` chain resolves to `rows[table] ?? []`. */
function makeFakeSb(rows: Table, overrides: { tenantSettings?: Record<string, any> } = {}) {
  const tenantRow = rows.restaurant_tenants?.[0];
  const tenant = {
    id: TENANT,
    name: tenantRow ? tenantRow.name : "Kilimanjaro Grill",
    settings: overrides.tenantSettings ?? {},
  };
  let updatedSettings: any = null;

  return {
    from(table: string) {
      const data = rows[table] ?? [];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        gte: () => chain,
        limit: () => chain,
        order: () => chain,
        single: async () =>
          table === "restaurant_tenants"
            ? { data: tenant, error: null }
            : { data: data[0] ?? null, error: null },
        maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
        then: (resolve: any) => resolve({ data, error: null }),
        update: (patch: any) => {
          updatedSettings = patch.settings;
          return {
            eq: async () => ({ data: null, error: null }),
          };
        },
      };
      // Make the chain itself awaitable (Promise-like) for `await sb.from(...).select()...`.
      chain[Symbol.toStringTag] = "Promise";
      return chain;
    },
    getUpdatedSettings: () => updatedSettings,
  };
}

beforeEach(() => {
  assertTenantReadMock.mockReset().mockResolvedValue(undefined);
  assertCapabilityMock.mockReset().mockResolvedValue(undefined);
  getTenantScopeMock.mockReset().mockResolvedValue({ platformAdmin: false, grants: [] });
  pricingReadinessMock.mockReset().mockResolvedValue({
    generatedAt: new Date().toISOString(),
    channel: "dine_in",
    total: 0,
    ready: 0,
    blocked: 0,
    divergent: 0,
    rulesInForce: {
      prices: 0,
      priceLists: 0,
      taxes: 0,
      serviceCharges: 0,
      promotions: 0,
      roundingRules: 0,
    },
    rows: [],
  });
});

describe("computeReadiness — zero state", () => {
  it("reports every critical domain BLOCKED and goLiveState NOT_READY for a brand-new tenant", async () => {
    const sb = makeFakeSb({ restaurant_tenants: [{ name: null }] });
    const report = await computeReadiness(sb, OWNER, TENANT);

    expect(assertTenantReadMock).toHaveBeenCalledWith(sb, OWNER, TENANT);
    expect(report.goLiveState).toBe("NOT_READY");
    expect(report.criticalBlockers).toBeGreaterThan(0);

    const business = report.items.find((i) => i.domain === "business")!;
    expect(business.status).toBe("BLOCKED");
    expect(business.severity).toBe("CRITICAL");
    expect(business.blocker).not.toBeNull();

    const property = report.items.find((i) => i.domain === "property")!;
    expect(property.status).toBe("BLOCKED");
    // Blocked because business itself is unset — a genuine dependency chain.
    expect(property.blockedByDependency).toBe(true);
  });

  it("never exposes internal terminology in any item's plain-language fields", async () => {
    const sb = makeFakeSb({ restaurant_tenants: [{ name: null }] });
    const report = await computeReadiness(sb, OWNER, TENANT);
    const forbidden = /tenant_id|rpc|rls|restaurant_members|server function|uuid/i;
    for (const i of report.items) {
      expect(i.title).not.toMatch(forbidden);
      expect(i.explanation).not.toMatch(forbidden);
      expect(i.currentState).not.toMatch(forbidden);
      if (i.blocker) expect(i.blocker).not.toMatch(forbidden);
    }
  });
});

describe("computeReadiness — staff & roles", () => {
  it("is COMPLETE-but-non-blocking (WARNING) when only the owner has access", async () => {
    const sb = makeFakeSb({
      restaurant_tenants: [{ name: "Kilimanjaro Grill" }],
      restaurant_members: [{ id: "m1", role: "owner" }],
    });
    const report = await computeReadiness(sb, OWNER, TENANT);
    const staff = report.items.find((i) => i.domain === "staff")!;
    expect(staff.status).toBe("WARNING");
    expect(staff.severity).toBe("LOW");
    // A WARNING on staff must never contribute to a critical blocker count.
    expect(report.criticalBlockers).toBe(
      report.items.filter(
        (i) => i.domain !== "final_check" && i.status === "BLOCKED" && i.severity === "CRITICAL",
      ).length,
    );
  });

  it("is COMPLETE once more than the owner is registered", async () => {
    const sb = makeFakeSb({
      restaurant_tenants: [{ name: "Kilimanjaro Grill" }],
      restaurant_members: [
        { id: "m1", role: "owner" },
        { id: "m2", role: "bartender" },
      ],
    });
    const report = await computeReadiness(sb, OWNER, TENANT);
    expect(report.items.find((i) => i.domain === "staff")!.status).toBe("COMPLETE");
  });
});

describe("computeReadiness — dependency propagation", () => {
  it("Menu is blocked-by-dependency when there is no outlet or operating model yet", async () => {
    const sb = makeFakeSb({ restaurant_tenants: [{ name: "Kilimanjaro Grill" }] });
    const report = await computeReadiness(sb, OWNER, TENANT);
    const menu = report.items.find((i) => i.domain === "menu")!;
    expect(menu.status).toBe("BLOCKED");
    expect(menu.blockedByDependency).toBe(true);
  });

  it("Recipes & Costing is blocked because no products exist yet, not because of a missing recipe itself", async () => {
    const sb = makeFakeSb({ restaurant_tenants: [{ name: "Kilimanjaro Grill" }] });
    const report = await computeReadiness(sb, OWNER, TENANT);
    const costing = report.items.find((i) => i.domain === "recipes_costing")!;
    expect(costing.status).toBe("BLOCKED");
    expect(costing.blockedByDependency).toBe(true);
  });

  it("Recipes & Costing blocks on its own data once products exist but none carry a recipe", async () => {
    const sb = makeFakeSb({
      restaurant_tenants: [{ name: "Kilimanjaro Grill" }],
      restaurant_products: [{ id: "p1", active: true, recipe_id: null }],
    });
    const report = await computeReadiness(sb, OWNER, TENANT);
    const costing = report.items.find((i) => i.domain === "recipes_costing")!;
    expect(costing.status).toBe("BLOCKED");
    expect(costing.blockedByDependency).toBe(false);
    expect(costing.blocker).toMatch(/recipe/i);
  });
});

describe("computeReadiness — pricing (reuses the real POS pricing engine, never re-derives it)", () => {
  it("is BLOCKED when pricingReadiness reports any unpriced item, with the exact count surfaced", async () => {
    pricingReadinessMock.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      channel: "dine_in",
      total: 5,
      ready: 3,
      blocked: 2,
      divergent: 0,
      rulesInForce: {
        prices: 3,
        priceLists: 0,
        taxes: 0,
        serviceCharges: 0,
        promotions: 0,
        roundingRules: 0,
      },
      rows: [],
    });
    const sb = makeFakeSb({ restaurant_tenants: [{ name: "Kilimanjaro Grill" }] });
    const report = await computeReadiness(sb, OWNER, TENANT);
    const pricing = report.items.find((i) => i.domain === "pricing")!;
    expect(pricing.status).toBe("BLOCKED");
    expect(pricing.blocker).toContain("2 menu items");
    expect(pricingReadinessMock).toHaveBeenCalledWith(sb, OWNER, { tenantId: TENANT });
  });

  it("is COMPLETE when every sellable item resolves a price", async () => {
    pricingReadinessMock.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      channel: "dine_in",
      total: 4,
      ready: 4,
      blocked: 0,
      divergent: 0,
      rulesInForce: {
        prices: 4,
        priceLists: 0,
        taxes: 0,
        serviceCharges: 0,
        promotions: 0,
        roundingRules: 0,
      },
      rows: [],
    });
    const sb = makeFakeSb({ restaurant_tenants: [{ name: "Kilimanjaro Grill" }] });
    const report = await computeReadiness(sb, OWNER, TENANT);
    expect(report.items.find((i) => i.domain === "pricing")!.status).toBe("COMPLETE");
  });
});

describe("computeReadiness — tables & service depends on operating model", () => {
  it("is NOT_APPLICABLE for a takeaway-only tenant, never blocking go-live", async () => {
    const sb = makeFakeSb(
      { restaurant_tenants: [{ name: "Kilimanjaro Grill" }] },
      { tenantSettings: { onboarding: { operatingMode: "takeaway" } } },
    );
    const report = await computeReadiness(sb, OWNER, TENANT);
    const tables = report.items.find((i) => i.domain === "tables_service")!;
    expect(tables.status).toBe("NOT_APPLICABLE");
    expect(tables.severity).toBe("OPTIONAL");
  });

  it("is a non-blocking WARNING for table-service tenants with no tables yet", async () => {
    const sb = makeFakeSb(
      { restaurant_tenants: [{ name: "Kilimanjaro Grill" }] },
      { tenantSettings: { onboarding: { operatingMode: "table_service" } } },
    );
    const report = await computeReadiness(sb, OWNER, TENANT);
    expect(report.items.find((i) => i.domain === "tables_service")!.status).toBe("WARNING");
  });
});

describe("computeReadiness — fiscalisation is market-scoped, not universal", () => {
  it("is NOT_APPLICABLE (and OPTIONAL severity) outside Tanzania", async () => {
    const sb = makeFakeSb(
      { restaurant_tenants: [{ name: "Kilimanjaro Grill" }] },
      { tenantSettings: { onboarding: { country: "Kenya" } } },
    );
    const report = await computeReadiness(sb, OWNER, TENANT);
    const fiscal = report.items.find((i) => i.domain === "fiscalisation")!;
    expect(fiscal.status).toBe("NOT_APPLICABLE");
    expect(fiscal.severity).toBe("OPTIONAL");
  });

  it("is CRITICAL and BLOCKED in Tanzania with no registered device", async () => {
    const sb = makeFakeSb(
      { restaurant_tenants: [{ name: "Kilimanjaro Grill" }] },
      { tenantSettings: { onboarding: { country: "Tanzania" } } },
    );
    const report = await computeReadiness(sb, OWNER, TENANT);
    const fiscal = report.items.find((i) => i.domain === "fiscalisation")!;
    expect(fiscal.status).toBe("BLOCKED");
    expect(fiscal.severity).toBe("CRITICAL");
  });
});

describe("computeReadiness — weighted progress and go-live gating", () => {
  it("progressPercent is 100 and goLiveState is READY_FOR_GO_LIVE only once every critical/high item is done and a real sale exists", async () => {
    const sb = makeFakeSb(
      {
        restaurant_tenants: [{ name: "Kilimanjaro Grill" }],
        restaurant_properties: [{ id: "p1" }],
        restaurant_locations: [
          { id: "l1", is_storage: false },
          { id: "l2", is_storage: true },
        ],
        restaurant_members: [{ id: "m1" }, { id: "m2" }],
        restaurant_menus: [{ id: "menu1", status: "published" }],
        restaurant_menu_items: [
          { id: "mi1", menu_id: "menu1", available: true, archived_at: null },
        ],
        restaurant_products: [{ id: "prod1", active: true, recipe_id: "r1" }],
        restaurant_tax_rules: [{ id: "t1" }],
        restaurant_inventory_units: [{ id: "u1" }],
        restaurant_inventory_items: [{ id: "i1" }],
        restaurant_suppliers: [{ id: "s1" }],
        restaurant_stations: [{ id: "st1" }],
        restaurant_tables: [{ id: "tb1" }],
        restaurant_service_periods: [{ id: "sp1" }],
        restaurant_orders: [{ id: "o1" }],
        restaurant_mobile_money_accounts: [{ id: "a1", activation_state: "active" }],
      },
      { tenantSettings: { onboarding: { operatingMode: "table_service", country: "Kenya" } } },
    );
    pricingReadinessMock.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      channel: "dine_in",
      total: 1,
      ready: 1,
      blocked: 0,
      divergent: 0,
      rulesInForce: {
        prices: 1,
        priceLists: 0,
        taxes: 0,
        serviceCharges: 0,
        promotions: 0,
        roundingRules: 0,
      },
      rows: [],
    });
    const report = await computeReadiness(sb, OWNER, TENANT);
    expect(report.criticalBlockers).toBe(0);
    expect(report.highBlockers).toBe(0);
    expect(report.hasRecordedTestSale).toBe(true);
    expect(report.goLiveState).toBe("READY_FOR_GO_LIVE");
    expect(report.progressPercent).toBe(100);
  });

  it("stays READY_FOR_TEST (not READY_FOR_GO_LIVE) when configuration is complete but no real sale has ever been recorded", async () => {
    const sb = makeFakeSb(
      {
        restaurant_tenants: [{ name: "Kilimanjaro Grill" }],
        restaurant_properties: [{ id: "p1" }],
        restaurant_locations: [
          { id: "l1", is_storage: false },
          { id: "l2", is_storage: true },
        ],
        restaurant_members: [{ id: "m1" }, { id: "m2" }],
        restaurant_menus: [{ id: "menu1", status: "published" }],
        restaurant_menu_items: [
          { id: "mi1", menu_id: "menu1", available: true, archived_at: null },
        ],
        restaurant_products: [{ id: "prod1", active: true, recipe_id: "r1" }],
        restaurant_tax_rules: [{ id: "t1" }],
        restaurant_inventory_units: [{ id: "u1" }],
        restaurant_inventory_items: [{ id: "i1" }],
        restaurant_suppliers: [{ id: "s1" }],
        restaurant_stations: [{ id: "st1" }],
        restaurant_tables: [{ id: "tb1" }],
        restaurant_service_periods: [{ id: "sp1" }],
        restaurant_orders: [],
      },
      { tenantSettings: { onboarding: { operatingMode: "table_service", country: "Kenya" } } },
    );
    pricingReadinessMock.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      channel: "dine_in",
      total: 1,
      ready: 1,
      blocked: 0,
      divergent: 0,
      rulesInForce: {
        prices: 1,
        priceLists: 0,
        taxes: 0,
        serviceCharges: 0,
        promotions: 0,
        roundingRules: 0,
      },
      rows: [],
    });
    const report = await computeReadiness(sb, OWNER, TENANT);
    expect(report.hasRecordedTestSale).toBe(false);
    expect(report.goLiveState).toBe("READY_FOR_TEST");
  });
});

describe("confirmGoLive — a deliberate, audited, capability-gated action, never an automatic inference", () => {
  it("refuses to confirm go-live when the tenant is not actually READY_FOR_GO_LIVE", async () => {
    const sb = makeFakeSb({ restaurant_tenants: [{ name: null }] });
    await expect(confirmGoLive(sb, OWNER, TENANT)).rejects.toThrow(/not ready/i);
    expect(assertCapabilityMock).toHaveBeenCalledWith(sb, OWNER, TENANT, "tenant.manage");
  });

  it("requires tenant.manage even to attempt confirmation", async () => {
    assertCapabilityMock.mockRejectedValueOnce(new Error("Forbidden — insufficient role."));
    const sb = makeFakeSb({ restaurant_tenants: [{ name: null }] });
    await expect(confirmGoLive(sb, OWNER, TENANT)).rejects.toThrow(/forbidden/i);
  });
});
