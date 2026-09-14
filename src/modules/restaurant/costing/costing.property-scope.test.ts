/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P09 enterprise closure — configuration governance, expanded coverage.
 *
 * `menu.property-scope.test.ts` proved the config-governance fix
 * (0062_p09_config_governance_property_scope.sql) for one representative
 * table (menus). This file proves the identical fix for recipe costing:
 * restaurant_recipe_components/_costs have no property_id column of
 * their own — upsertRecipeComponent and computeRecipeCost both resolve
 * scope via menu_item_id -> menu_id -> restaurant_menus.property_id (the
 * same derived-scope pattern already proven for upsertMenuItem). Does
 * NOT mock "../core/access.server", so the real property-scope logic
 * actually runs.
 */
import { describe, expect, it, vi } from "vitest";
import { computeRecipeCost, upsertRecipeComponent } from "./costing.server";

vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));

const TENANT_A = "tenant-a";
const PROPERTY_A1 = "property-a1";
const PROPERTY_A2 = "property-a2";

const USER_RM_A1 = "rm-a1"; // restaurant_manager scoped to Property A1 — covers costing.manage
const USER_OWNER_TENANT_WIDE = "owner-tenant-wide";

function makeFakeSupabase() {
  const db: Record<string, any[]> = {
    restaurant_members: [
      { tenant_id: TENANT_A, user_id: USER_RM_A1, role: "restaurant_manager", property_id: PROPERTY_A1 },
      { tenant_id: TENANT_A, user_id: USER_OWNER_TENANT_WIDE, role: "owner", property_id: null },
    ],
    restaurant_menus: [
      { id: "menu-a1", tenant_id: TENANT_A, property_id: PROPERTY_A1, location_id: null },
      { id: "menu-a2", tenant_id: TENANT_A, property_id: PROPERTY_A2, location_id: null },
    ],
    restaurant_menu_items: [
      { id: "item-a1", tenant_id: TENANT_A, menu_id: "menu-a1", name: "A1 Dish", price: 10000, currency: "TZS" },
      { id: "item-a2", tenant_id: TENANT_A, menu_id: "menu-a2", name: "A2 Dish", price: 10000, currency: "TZS" },
    ],
    restaurant_recipe_components: [],
  };
  let seq = 0;

  function builder(table: string) {
    db[table] = db[table] ?? [];
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "insert" = "select";
    let payload: any = null;

    const api: any = {
      select: () => api,
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return api;
      },
      insert(row: any) {
        mode = "insert";
        payload = row;
        return api;
      },
      async single() {
        const r = run();
        const d = r[0];
        return d ? { data: d, error: null } : { data: null, error: { message: `${table}: not found` } };
      },
      async maybeSingle() {
        const r = run();
        return { data: r[0] ?? null, error: null };
      },
      then(resolve: any) {
        resolve({ data: run(), error: null });
      },
    };

    function run(): any[] {
      if (mode === "select") return db[table]!.filter((r) => filters.every((f) => f(r)));
      const row = { id: `${table}-new-${++seq}`, ...payload };
      db[table]!.push(row);
      return [row];
    }
    return api;
  }

  return { from: (t: string) => builder(t), rpc: async () => ({ data: false, error: null }) } as any;
}

describe("upsertRecipeComponent — scope is inherited from the menu item's own menu", () => {
  it("a restaurant_manager scoped to Property A1 CAN add a component to item-a1 (their own property's menu)", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertRecipeComponent(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      menuItemId: "item-a1",
      quantity: 1,
      yieldPercent: 100,
    } as any);
    expect(created).toBeTruthy();
  });

  it("a restaurant_manager scoped to Property A1 CANNOT add a component to item-a2 (sibling property's menu) — the core escalation this closes", async () => {
    const sb = makeFakeSupabase();
    await expect(
      upsertRecipeComponent(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        menuItemId: "item-a2",
        quantity: 1,
        yieldPercent: 100,
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a tenant-wide owner CAN add a component to any property's menu item", async () => {
    const sb = makeFakeSupabase();
    const created = await upsertRecipeComponent(sb, USER_OWNER_TENANT_WIDE, {
      tenantId: TENANT_A,
      menuItemId: "item-a2",
      quantity: 1,
      yieldPercent: 100,
    } as any);
    expect(created).toBeTruthy();
  });
});

describe("computeRecipeCost — scope is inherited from the menu item's own menu", () => {
  it("a restaurant_manager scoped to Property A1 CANNOT compute costing for item-a2 (sibling property's menu)", async () => {
    const sb = makeFakeSupabase();
    await expect(
      computeRecipeCost(sb, USER_RM_A1, {
        tenantId: TENANT_A,
        menuItemId: "item-a2",
        overheadCost: 0,
      } as any),
    ).rejects.toThrow(/not granted to you at this property/i);
  });

  it("a restaurant_manager scoped to Property A1 CAN compute costing for item-a1 (their own property's menu)", async () => {
    const sb = makeFakeSupabase();
    const result = await computeRecipeCost(sb, USER_RM_A1, {
      tenantId: TENANT_A,
      menuItemId: "item-a1",
      overheadCost: 0,
    } as any);
    expect(result).toBeTruthy();
  });
});
