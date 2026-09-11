/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Regression coverage for the exact class of defect reported live: Classic
 * Chicken Burger was published, priced, and backed by an active, fully
 * costed recipe (CCB-01, computed_cost TZS 4,591) — but no
 * restaurant_products row ever linked the menu item to that recipe, so
 * Pricing Centre and POS costing (both resolve recipe cost strictly through
 * restaurant_products.menu_item_id -> recipe_id) never saw it. The existing
 * `missing_recipes` fact could not have caught this: it only scans existing
 * product rows for a missing recipe_id, and here there was no product row
 * at all. `orphaned_menu_items` is the new fact that closes that blind
 * spot — a plain statement of "this sellable menu item has no product",
 * never a guess at which recipe it should use.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({ assertTenantRead: vi.fn(async () => true) }));

const { getProductEvidence } = await import("./evidence.server");

const TENANT = "tenant-1";
const USER = "user-1";
const MENU = "menu-1";
const OTHER_MENU_DRAFT = "menu-draft";

function fakeDb(rows: Record<string, any[]>) {
  function from(table: string) {
    let filtered = (rows[table] ?? []).map((r: any) => ({ ...r }));
    const api: any = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return api;
      },
      not(col: string, _op: string, val: unknown) {
        if (val === null) filtered = filtered.filter((r) => r[col] != null);
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
    };
    return api;
  }
  return { from } as any;
}

function baseRows(overrides: Partial<Record<string, any[]>> = {}) {
  return {
    restaurant_products: [],
    restaurant_recipes: [],
    restaurant_recipe_cost_history: [],
    restaurant_productions: [],
    restaurant_order_items: [],
    restaurant_menus: [{ id: MENU, tenant_id: TENANT, status: "published" }],
    restaurant_menu_items: [],
    ...overrides,
  };
}

describe("getProductEvidence — orphaned_menu_items (the Classic Chicken Burger defect)", () => {
  it("flags a published, available menu item with an active fully-costed recipe but NO product row at all", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menu_items: [
          {
            id: "item-ccb",
            tenant_id: TENANT,
            menu_id: MENU,
            name: "Classic Chicken Burger",
            price: 18000,
            currency: "TZS",
            available: true,
          },
        ],
        restaurant_recipes: [
          {
            id: "recipe-ccb",
            tenant_id: TENANT,
            code: "CCB-01",
            name: "Classic Chicken Burger",
            version: 1,
            status: "active",
            computed_cost: 4591,
            currency: "TZS",
          },
        ],
        // The defect: zero restaurant_products rows reference either the
        // menu item or the recipe.
        restaurant_products: [],
      }),
    );

    const ev = await getProductEvidence(sb, USER, TENANT);
    expect(ev.orphaned_menu_items).toEqual([
      { menu_item_id: "item-ccb", name: "Classic Chicken Burger", price: 18000, currency: "TZS" },
    ]);
  });

  it("does not flag a menu item once an active product links it to its recipe", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menu_items: [
          {
            id: "item-ccb",
            tenant_id: TENANT,
            menu_id: MENU,
            name: "Classic Chicken Burger",
            price: 18000,
            currency: "TZS",
            available: true,
          },
        ],
        restaurant_recipes: [
          {
            id: "recipe-ccb",
            tenant_id: TENANT,
            code: "CCB-01",
            name: "Classic Chicken Burger",
            version: 1,
            status: "active",
            computed_cost: 4591,
            currency: "TZS",
          },
        ],
        restaurant_products: [
          {
            id: "product-ccb",
            tenant_id: TENANT,
            sku: "CCB-01",
            name: "Classic Chicken Burger",
            menu_item_id: "item-ccb",
            recipe_id: "recipe-ccb",
            active: true,
            product_type: "standard",
            price: 18000,
            currency: "TZS",
          },
        ],
      }),
    );

    const ev = await getProductEvidence(sb, USER, TENANT);
    expect(ev.orphaned_menu_items).toEqual([]);
    // The now-linked product also resolves a margin, proving the canonical
    // product -> recipe path is live for it.
    expect(ev.product_margin).toEqual([
      expect.objectContaining({ product_id: "product-ccb", cost: 4591, price: 18000 }),
    ]);
  });

  it("an inactive product does not count as a real link — the menu item stays flagged", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menu_items: [
          {
            id: "item-ccb",
            tenant_id: TENANT,
            menu_id: MENU,
            name: "Classic Chicken Burger",
            price: 18000,
            currency: "TZS",
            available: true,
          },
        ],
        restaurant_products: [
          {
            id: "product-ccb",
            tenant_id: TENANT,
            sku: "CCB-01",
            name: "Classic Chicken Burger",
            menu_item_id: "item-ccb",
            recipe_id: "recipe-ccb",
            active: false,
            product_type: "standard",
            price: 18000,
            currency: "TZS",
          },
        ],
      }),
    );

    const ev = await getProductEvidence(sb, USER, TENANT);
    expect(ev.orphaned_menu_items).toEqual([
      { menu_item_id: "item-ccb", name: "Classic Chicken Burger", price: 18000, currency: "TZS" },
    ]);
  });

  it("a menu item marked unavailable is not flagged — it isn't actually sellable", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menu_items: [
          {
            id: "item-hidden",
            tenant_id: TENANT,
            menu_id: MENU,
            name: "Hidden item",
            price: 5000,
            currency: "TZS",
            available: false,
          },
        ],
      }),
    );
    const ev = await getProductEvidence(sb, USER, TENANT);
    expect(ev.orphaned_menu_items).toEqual([]);
  });

  it("a menu item on a draft (unpublished) menu is not flagged — guests can't order it yet", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menus: [
          { id: MENU, tenant_id: TENANT, status: "published" },
          { id: OTHER_MENU_DRAFT, tenant_id: TENANT, status: "draft" },
        ],
        restaurant_menu_items: [
          {
            id: "item-draft",
            tenant_id: TENANT,
            menu_id: OTHER_MENU_DRAFT,
            name: "Coming soon",
            price: 5000,
            currency: "TZS",
            available: true,
          },
        ],
      }),
    );
    const ev = await getProductEvidence(sb, USER, TENANT);
    expect(ev.orphaned_menu_items).toEqual([]);
  });

  it("preserves the existing missing_recipes fact for a product that exists but has no recipe", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_products: [
          {
            id: "product-soda",
            tenant_id: TENANT,
            sku: "SODA-01",
            name: "Bottled soda",
            menu_item_id: null,
            recipe_id: null,
            active: true,
            product_type: "standard",
            price: 3000,
            currency: "TZS",
          },
        ],
      }),
    );
    const ev = await getProductEvidence(sb, USER, TENANT);
    expect(ev.missing_recipes).toEqual([
      { product_id: "product-soda", sku: "SODA-01", name: "Bottled soda", price: 3000 },
    ]);
  });
});
