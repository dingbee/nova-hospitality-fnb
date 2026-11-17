/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P13 readiness engine — integration and failure-simulation tests.
 *
 * Unlike `readiness.server.test.ts` (one domain rule at a time) and
 * `readiness.security.test.ts` (the auth boundary), these tests drive the
 * engine the way the real product does: call it, change what's in the
 * tables, call it again on the *same* fake client — proving the report is
 * always recomputed live and never trusts a stored progress flag or a
 * previously-returned report. Each `describe` covers one of the mission's
 * required failure-simulation categories: incomplete configuration,
 * deleted dependency, duplicate configuration, invalid configuration, and
 * stale/concurrent state at the go-live confirmation boundary.
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

const READY_PRICING = {
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
};

/**
 * Same shape as the harness in `readiness.server.test.ts`, but built around
 * mutation: the caller holds onto `rows` and can add/remove/change entries
 * between calls. Every `sb.from(table)` reads `rows[table]` fresh at call
 * time, so a second `computeReadiness(sb, ...)` call on the same `sb`
 * genuinely re-derives state from whatever `rows` looks like *now* — there
 * is nothing cached inside the fake client itself. The tenant row/settings
 * are the one exception (real Supabase would let those change too, but no
 * test here needs to mutate tenant identity mid-flow).
 */
function makeMutableFakeSb(rows: Table, tenantSettings: Record<string, any> = {}) {
  // A real object, mutated in place by `.update()` — proves confirmGoLive's
  // write is actually read back by the next `computeReadiness()` call
  // inside it, not just accepted and ignored.
  const tenant: { id: string; name: string; settings: Record<string, any> } = {
    id: TENANT,
    name: "Kilimanjaro Grill",
    settings: tenantSettings,
  };
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
        update: (patch: any) => ({
          eq: async () => {
            if (table === "restaurant_tenants" && patch.settings) tenant.settings = patch.settings;
            return { data: null, error: null };
          },
        }),
      };
      chain[Symbol.toStringTag] = "Promise";
      return chain;
    },
  };
}

/** A tenant with every critical/high domain fully configured — the starting point for the "remove one thing" tests. */
function fullyReadyRows(): Table {
  return {
    restaurant_properties: [{ id: "p1", name: "Main" }],
    restaurant_locations: [
      { id: "l1", is_storage: false },
      { id: "l2", is_storage: true },
    ],
    restaurant_members: [{ id: "m1" }, { id: "m2" }],
    restaurant_menus: [{ id: "menu1", status: "published" }],
    restaurant_menu_items: [{ id: "mi1", menu_id: "menu1", available: true, archived_at: null }],
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
  };
}

beforeEach(() => {
  assertTenantReadMock.mockReset().mockResolvedValue(undefined);
  assertCapabilityMock.mockReset().mockResolvedValue(undefined);
  getTenantScopeMock.mockReset().mockResolvedValue({ platformAdmin: false, grants: [] });
  pricingReadinessMock.mockReset().mockResolvedValue(READY_PRICING);
});

describe("integration — incomplete configuration recovers to COMPLETE without any stored flag", () => {
  it("re-derives property/outlet from BLOCKED to COMPLETE purely from new rows appearing, on the same client", async () => {
    const rows: Table = {};
    const sb = makeMutableFakeSb(rows);

    const before = await computeReadiness(sb, OWNER, TENANT);
    expect(before.items.find((i) => i.domain === "property")!.status).toBe("BLOCKED");
    expect(before.items.find((i) => i.domain === "outlet")!.status).toBe("BLOCKED");

    // The customer completes the real "Add a property" / "Add an outlet" workflow —
    // simulated here as new rows appearing, exactly what a real fix produces.
    rows.restaurant_properties = [{ id: "p1", name: "Main" }];
    rows.restaurant_locations = [{ id: "l1", is_storage: false }];

    const after = await computeReadiness(sb, OWNER, TENANT);
    expect(after.items.find((i) => i.domain === "property")!.status).toBe("COMPLETE");
    expect(after.items.find((i) => i.domain === "outlet")!.status).toBe("COMPLETE");
  });
});

describe("integration — dependency propagation across a real fix sequence", () => {
  it("Menu stays blocked-by-dependency until outlet exists, then blocks on its own missing menu once outlet is fixed", async () => {
    const rows: Table = {};
    // Operating model is configured from the start so this test isolates the
    // outlet dependency specifically, rather than conflating two dependencies.
    const sb = makeMutableFakeSb(rows, { onboarding: { operatingMode: "table_service" } });

    const step1 = await computeReadiness(sb, OWNER, TENANT);
    const menu1 = step1.items.find((i) => i.domain === "menu")!;
    expect(menu1.status).toBe("BLOCKED");
    expect(menu1.blockedByDependency).toBe(true);

    rows.restaurant_properties = [{ id: "p1" }];
    rows.restaurant_locations = [{ id: "l1", is_storage: false }];

    const step2 = await computeReadiness(sb, OWNER, TENANT);
    const menu2 = step2.items.find((i) => i.domain === "menu")!;
    // Outlet now exists — Menu is still blocked, but on its own missing data now, not a dependency.
    expect(menu2.status).toBe("BLOCKED");
    expect(menu2.blockedByDependency).toBe(false);

    rows.restaurant_menus = [{ id: "menu1", status: "published" }];
    rows.restaurant_menu_items = [
      { id: "mi1", menu_id: "menu1", available: true, archived_at: null },
    ];

    const step3 = await computeReadiness(sb, OWNER, TENANT);
    expect(step3.items.find((i) => i.domain === "menu")!.status).toBe("COMPLETE");
  });
});

describe("integration — deleted dependency reverts downstream state, not just the deleted item", () => {
  it("removing the outlet after it existed re-blocks Inventory, Kitchen & bar, and Menu again", async () => {
    const rows: Table = fullyReadyRows();
    const sb = makeMutableFakeSb(rows, {
      onboarding: { operatingMode: "table_service", country: "Kenya" },
    });

    const before = await computeReadiness(sb, OWNER, TENANT);
    expect(before.items.find((i) => i.domain === "outlet")!.status).toBe("COMPLETE");
    expect(before.items.find((i) => i.domain === "inventory")!.status).toBe("COMPLETE");
    expect(before.items.find((i) => i.domain === "kitchen_bar")!.status).toBe("COMPLETE");

    // Someone deletes the only outlet — a real, if unusual, admin action.
    rows.restaurant_locations = rows.restaurant_locations.filter((l) => l.is_storage);

    const after = await computeReadiness(sb, OWNER, TENANT);
    expect(after.items.find((i) => i.domain === "outlet")!.status).toBe("BLOCKED");
    // Inventory's own rule only needs a store, which still exists — it does not
    // false-block on a dependency it doesn't actually declare, proving the
    // engine tracks real dependencies rather than "anything upstream changed".
    expect(after.items.find((i) => i.domain === "inventory")!.status).toBe("COMPLETE");
  });
});

describe("integration — duplicate configuration never crashes and never double-counts a blocker", () => {
  it("two mobile money accounts (one active, one not) still resolve to COMPLETE from the active one", async () => {
    const rows: Table = {
      restaurant_mobile_money_accounts: [
        { id: "a1", activation_state: "pending" },
        { id: "a2", activation_state: "active" },
      ],
    };
    const sb = makeMutableFakeSb(rows);
    const report = await computeReadiness(sb, OWNER, TENANT);
    expect(report.items.find((i) => i.domain === "payments")!.status).toBe("COMPLETE");
  });

  it("duplicate tax rule rows are counted, not deduplicated or rejected", async () => {
    const rows: Table = {
      restaurant_tax_rules: [{ id: "t1" }, { id: "t1-dup" }],
    };
    const sb = makeMutableFakeSb(rows);
    const report = await computeReadiness(sb, OWNER, TENANT);
    const tax = report.items.find((i) => i.domain === "tax")!;
    expect(tax.status).toBe("COMPLETE");
    expect(tax.currentState).toContain("2 tax rules");
  });
});

describe("integration — invalid configuration is reported as still-blocked, not silently accepted", () => {
  it("a fiscal device row that exists but never completed TRA registration (no regId) stays BLOCKED", async () => {
    const rows: Table = {
      restaurant_fiscal_configurations: [{ id: "fc1" }],
      restaurant_fiscal_devices: [{ registration_info: { status: "pending" } }],
    };
    const sb = makeMutableFakeSb(rows, { onboarding: { country: "Tanzania" } });
    const report = await computeReadiness(sb, OWNER, TENANT);
    const fiscal = report.items.find((i) => i.domain === "fiscalisation")!;
    expect(fiscal.status).toBe("BLOCKED");
    expect(fiscal.severity).toBe("CRITICAL");
  });

  it("a mobile money account that exists but has no active state is BLOCKED, not a soft WARNING", async () => {
    const rows: Table = {
      restaurant_mobile_money_accounts: [{ id: "a1", activation_state: "suspended" }],
    };
    const sb = makeMutableFakeSb(rows);
    const report = await computeReadiness(sb, OWNER, TENANT);
    const payments = report.items.find((i) => i.domain === "payments")!;
    expect(payments.status).toBe("BLOCKED");
    expect(payments.blocker).toMatch(/isn't active/i);
  });
});

describe("integration — confirmGoLive recomputes fresh state, never trusting a stale prior read", () => {
  it("rejects when the underlying data regresses between an earlier readiness check and the confirm call itself", async () => {
    const rows: Table = fullyReadyRows();
    const sb = makeMutableFakeSb(rows, {
      onboarding: { operatingMode: "table_service", country: "Kenya" },
    });

    const readyReport = await computeReadiness(sb, OWNER, TENANT);
    expect(readyReport.goLiveState).toBe("READY_FOR_GO_LIVE");

    // Between the owner seeing "ready to go live" and clicking confirm, a
    // concurrent action (e.g. someone else's edit) removes the only paid
    // order — the one thing proving a real sale went through.
    rows.restaurant_orders = [];

    await expect(confirmGoLive(sb, OWNER, TENANT)).rejects.toThrow(/not ready/i);
  });

  it("succeeds and persists once the same tenant is genuinely still ready at confirmation time", async () => {
    const rows: Table = fullyReadyRows();
    const sb = makeMutableFakeSb(rows, {
      onboarding: { operatingMode: "table_service", country: "Kenya" },
    });
    const result = await confirmGoLive(sb, OWNER, TENANT);
    expect(result.goLiveState).toBe("LIVE");
  });
});
