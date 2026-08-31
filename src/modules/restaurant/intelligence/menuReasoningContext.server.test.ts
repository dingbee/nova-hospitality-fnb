/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * INT-01 — the context builder must be deterministic, tenant-scoped, and
 * bounded regardless of tenant size, and every fact it hands to a model
 * must be traceable back to real menu_item rows (provenance).
 */
import { describe, expect, it } from "vitest";
import {
  buildMenuIntelligenceContext,
  factIdsOf,
  hashMenuIntelligenceContext,
} from "./menuReasoningContext.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const OWNER = "user-owner";
const VIEWER = "user-viewer";

function makeFakeSupabase(opts: {
  tenants: Array<{ id: string; name: string; settings: any }>;
  members: Array<{ tenant_id: string; user_id: string; role: string }>;
  orders: Array<{
    id: string;
    tenant_id: string;
    closed_at: string;
    currency: string;
    status: string;
  }>;
  menuItems: Array<{
    id: string;
    tenant_id: string;
    name: string;
    price: number;
    currency: string;
  }>;
  orderItems: Array<{
    order_id: string;
    tenant_id: string;
    menu_item_id: string;
    description: string;
    quantity: number;
    line_total: number;
    line_cost: number;
    status: string;
  }>;
  recipeCosts?: Array<Record<string, any>>;
}) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      gte(col: string, val: string) {
        filters.push((r) => r[col] >= val);
        return api;
      },
      not(col: string, _kind: string, val: unknown) {
        if (val === null) filters.push((r) => r[col] != null);
        return api;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filters.push((r) => set.has(r[col]));
        return api;
      },
      order: () => api,
      limit: () => api,
      maybeSingle: async () => {
        const rows = source(table).filter((r: any) => filters.every((f) => f(r)));
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: any[]; error: any }) => unknown) => {
        const rows = source(table).filter((r: any) => filters.every((f) => f(r)));
        return resolve({ data: rows, error: null });
      },
    };
    return api;
  }

  function source(table: string): any[] {
    switch (table) {
      case "restaurant_tenants":
        return opts.tenants;
      case "restaurant_members":
        return opts.members;
      case "restaurant_orders":
        return opts.orders;
      case "restaurant_menu_items":
        return opts.menuItems;
      case "restaurant_order_items":
        return opts.orderItems;
      case "restaurant_recipe_costs":
        return opts.recipeCosts ?? [];
      default:
        return [];
    }
  }

  function rpc() {
    return Promise.resolve({ data: false, error: null });
  }

  return { from, rpc } as any;
}

const NOW = Date.now();
const recentIso = (daysAgo: number) => new Date(NOW - daysAgo * 864e5).toISOString();

function baseFixture(itemCount = 3) {
  const menuItems = Array.from({ length: itemCount }, (_, i) => ({
    id: `item-${i}`,
    tenant_id: TENANT,
    name: `Dish ${i}`,
    price: 10000 + i * 500,
    currency: "TZS",
  }));
  const orders = [
    {
      id: "order-1",
      tenant_id: TENANT,
      closed_at: recentIso(2),
      currency: "TZS",
      status: "closed",
    },
  ];
  const orderItems = menuItems.map((m, i) => ({
    order_id: "order-1",
    tenant_id: TENANT,
    menu_item_id: m.id,
    description: m.name,
    quantity: 5 + i,
    line_total: (10000 + i * 500) * (5 + i),
    line_cost: 3000 * (5 + i),
    status: "served",
  }));
  return {
    tenants: [
      { id: TENANT, name: "Demo Tenant", settings: { business: { tradingName: "Baobab Grove" } } },
      { id: OTHER_TENANT, name: "Other Tenant", settings: {} },
    ],
    members: [{ tenant_id: TENANT, user_id: OWNER, role: "owner" }],
    orders,
    menuItems,
    orderItems,
  };
}

describe("buildMenuIntelligenceContext", () => {
  it("resolves the tenant's real business name and currency, never a hardcoded value", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const ctx = await buildMenuIntelligenceContext(sb, OWNER, { tenantId: TENANT, windowDays: 30 });
    expect(ctx.restaurant.businessName).toBe("Baobab Grove");
    expect(ctx.restaurant.currency).toBe("TZS");
    expect(ctx.restaurant.tenantId).toBe(TENANT);
  });

  it("requires intelligence.read — a role without it is rejected", async () => {
    const fixture = baseFixture();
    fixture.members = [{ tenant_id: TENANT, user_id: VIEWER, role: "viewer" }];
    const sb = makeFakeSupabase(fixture);
    await expect(
      buildMenuIntelligenceContext(sb, VIEWER, { tenantId: TENANT, windowDays: 30 }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("a user with no membership in this tenant is rejected — no cross-tenant context ever built", async () => {
    const sb = makeFakeSupabase(baseFixture());
    await expect(
      buildMenuIntelligenceContext(sb, "stranger", { tenantId: TENANT, windowDays: 30 }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("is tenant-scoped: another tenant's menu items never appear, even if requested by an owner of a DIFFERENT tenant", async () => {
    const fixture = baseFixture();
    fixture.members.push({ tenant_id: OTHER_TENANT, user_id: "other-owner", role: "owner" });
    fixture.menuItems.push({
      id: "item-other",
      tenant_id: OTHER_TENANT,
      name: "Other Dish",
      price: 1,
      currency: "TZS",
    });
    const sb = makeFakeSupabase(fixture);
    const ctx = await buildMenuIntelligenceContext(sb, "other-owner", {
      tenantId: OTHER_TENANT,
      windowDays: 30,
    });
    expect(ctx.menu.every((m) => m.name !== "Dish 0")).toBe(true);
    expect(ctx.hasData).toBe(false); // other tenant has no orders in this fixture
  });

  it("every fact's factId is present in factIdsOf() and traces back to a real menu item id", async () => {
    const sb = makeFakeSupabase(baseFixture());
    const ctx = await buildMenuIntelligenceContext(sb, OWNER, { tenantId: TENANT, windowDays: 30 });
    const ids = factIdsOf(ctx);
    for (const fact of ctx.menu) {
      expect(ids.has(fact.factId)).toBe(true);
      expect(fact.factId).toBe(`menu-item:${fact.menuItemId}`);
      expect(["item-0", "item-1", "item-2"]).toContain(fact.menuItemId);
    }
    expect(ids.has(ctx.totals.factId)).toBe(true);
  });

  it("bounds the number of menu facts regardless of how many distinct items the tenant has", async () => {
    const sb = makeFakeSupabase(baseFixture(40));
    const ctx = await buildMenuIntelligenceContext(sb, OWNER, { tenantId: TENANT, windowDays: 30 });
    expect(ctx.menu.length).toBeLessThanOrEqual(16);
  });

  it("hasData is false when the tenant has no sales in the window — the reasoning gate short-circuits on this, not on ctx.menu being empty (a zero-sales item can still legitimately surface as a cost-review fact)", async () => {
    const fixture = baseFixture();
    fixture.orders = [];
    fixture.orderItems = [];
    const sb = makeFakeSupabase(fixture);
    const ctx = await buildMenuIntelligenceContext(sb, OWNER, { tenantId: TENANT, windowDays: 30 });
    expect(ctx.hasData).toBe(false);
    expect(ctx.totals.itemsSold).toBe(0);
  });

  it("is deterministic/reproducible: the same DB state and inputs produce an identical context hash", async () => {
    const fixture = baseFixture();
    const ctxA = await buildMenuIntelligenceContext(makeFakeSupabase(fixture), OWNER, {
      tenantId: TENANT,
      windowDays: 30,
    });
    const ctxB = await buildMenuIntelligenceContext(makeFakeSupabase(fixture), OWNER, {
      tenantId: TENANT,
      windowDays: 30,
    });
    // generatedAt comes from getMenuIntelligence's own new Date() — strip it before hashing to prove content-determinism (the hash function itself just hashes whatever it's given).
    const strip = (c: typeof ctxA) => ({ ...c, period: { ...c.period, generatedAt: "" } });
    expect(hashMenuIntelligenceContext(strip(ctxA))).toBe(hashMenuIntelligenceContext(strip(ctxB)));
  });

  it("a different windowDays input produces a different, still-deterministic context", async () => {
    const fixture = baseFixture();
    const ctx7 = await buildMenuIntelligenceContext(makeFakeSupabase(fixture), OWNER, {
      tenantId: TENANT,
      windowDays: 7,
    });
    const ctx60 = await buildMenuIntelligenceContext(makeFakeSupabase(fixture), OWNER, {
      tenantId: TENANT,
      windowDays: 60,
    });
    expect(ctx7.period.windowDays).toBe(7);
    expect(ctx60.period.windowDays).toBe(60);
  });
});
