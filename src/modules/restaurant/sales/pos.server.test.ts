/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { fetchSellableCatalog } from "./pos.server";

/**
 * Regression fixture for a real UAT-tenant defect: fetchSellableCatalog
 * picked only `menuIds[0]` (the single most-recently-updated published
 * menu) whenever no explicit menuId was given — which is how both POS
 * (pos.server.ts's posCatalog) and Guest Self-Order (selforder.server.ts's
 * guestMenu/submitGuestOrder) always call it. A tenant that runs more than
 * one published menu at once (a Restaurant menu and a separate Bar menu,
 * both scoped to the same location — exactly what Menu Management's own
 * "Versioned menus per outlet" model supports) had every published menu
 * except the single newest one silently vanish from both ordering
 * channels, even though Menu Management itself showed all of them as
 * published. Reproduced against live UAT data: UAT Tenant A had three
 * published menus sharing location_id=null — an empty "Lunch" menu with
 * the newest updated_at, plus two populated menus with 4 and 1 items —
 * so POS/Guest showed zero items despite 5 valid, published, priced items
 * existing.
 */

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";
const LOCATION = "loc-1";
const OTHER_LOCATION = "loc-2";

function fakeDb(rows: Record<string, any[]>) {
  function from(table: string) {
    let filtered = rows[table] ?? [];
    const builder: any = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filtered = filtered.filter((r) => set.has(r[col]));
        return builder;
      },
      // Mirrors the exact `location_id.is.null,location_id.eq.<id>` clause
      // fetchSellableCatalog builds — a scoped menu is visible everywhere
      // its own location matches, and a tenant-wide (location_id null) menu
      // is visible from any location.
      or(clause: string) {
        const conditions = clause.split(",").map((c) => {
          const [col, op, val] = c.split(".");
          return { col: col!, op: op!, val };
        });
        filtered = filtered.filter((r) =>
          conditions.some((c) => (c.op === "is" ? r[c.col] == null : String(r[c.col]) === c.val)),
        );
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle: async () => ({ data: filtered[0] ?? null }),
      single: async () => ({
        data: filtered[0] ?? null,
        error: filtered[0] ? null : { message: "not found" },
      }),
      then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
    };
    return builder;
  }
  return { from };
}

function menu(id: string, overrides: Partial<Record<string, any>> = {}) {
  return {
    id,
    name: id,
    status: "published",
    currency: "TZS",
    location_id: null,
    tenant_id: TENANT,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function item(id: string, menuId: string, overrides: Partial<Record<string, any>> = {}) {
  return {
    id,
    menu_id: menuId,
    category_id: null,
    name: id,
    description: "",
    price: 10000,
    currency: "TZS",
    available: true,
    tags: [],
    allergens: [],
    sort_order: 1,
    image_url: null,
    tenant_id: TENANT,
    ...overrides,
  };
}

function price(menuItemId: string, overrides: Partial<Record<string, any>> = {}) {
  return {
    id: `price-${menuItemId}`,
    scope: "tenant",
    amount: 10000,
    currency: "TZS",
    tax_inclusive: false,
    version: 1,
    status: "active",
    effective_from: "2020-01-01T00:00:00.000Z",
    effective_to: null,
    property_id: null,
    location_id: null,
    product_id: null,
    variant_id: null,
    menu_item_id: menuItemId,
    price_list_id: null,
    channel: null,
    tenant_id: TENANT,
    ...overrides,
  };
}

function baseRows(overrides: Partial<Record<string, any[]>> = {}) {
  return {
    restaurant_categories: [],
    restaurant_menus: [],
    restaurant_menu_items: [],
    restaurant_products: [],
    restaurant_product_variants: [],
    restaurant_modifier_groups: [],
    restaurant_modifiers: [],
    restaurant_product_modifier_groups: [],
    restaurant_stations: [
      { id: "st-kitchen", station_type: "kitchen", active: true, tenant_id: TENANT },
      { id: "st-bar", station_type: "bar", active: true, tenant_id: TENANT },
    ],
    restaurant_prices: [],
    ...overrides,
  };
}

describe("fetchSellableCatalog — multiple published menus", () => {
  it("1. a published restaurant menu item appears in the catalogue (POS uses this same catalogue)", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menus: [menu("menu-restaurant")],
        restaurant_menu_items: [item("item-steak", "menu-restaurant")],
        restaurant_products: [
          {
            id: "prod-steak",
            name: "Steak",
            menu_item_id: "item-steak",
            station_id: "st-kitchen",
            price: null,
            product_type: "menu_item",
            active: true,
            tenant_id: TENANT,
          },
        ],
        restaurant_prices: [price("item-steak")],
      }),
    );
    const catalog = await fetchSellableCatalog(sb, TENANT, {});
    expect(catalog.items.map((i: any) => i.id)).toContain("item-steak");
    const steak = catalog.items.find((i: any) => i.id === "item-steak") as any;
    expect(steak.station_id).toBe("st-kitchen");
    expect(steak.priceConfigured).toBe(true);
  });

  it("2/3. a second published menu (e.g. a separate Bar menu) is NOT silently dropped — both restaurant and bar items appear together, each on their own station", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menus: [
          // The Bar menu is the most recently updated — under the old
          // `menuIds[0]` logic this alone would have been picked and the
          // Restaurant menu's item would have vanished entirely.
          menu("menu-bar", { updated_at: "2026-01-02T00:00:00.000Z" }),
          menu("menu-restaurant", { updated_at: "2026-01-01T00:00:00.000Z" }),
        ],
        restaurant_menu_items: [
          item("item-steak", "menu-restaurant"),
          item("item-mojito", "menu-bar"),
        ],
        restaurant_products: [
          {
            id: "prod-steak",
            name: "Steak",
            menu_item_id: "item-steak",
            station_id: "st-kitchen",
            price: null,
            product_type: "menu_item",
            active: true,
            tenant_id: TENANT,
          },
          {
            id: "prod-mojito",
            name: "Mojito",
            menu_item_id: "item-mojito",
            station_id: "st-bar",
            price: null,
            product_type: "menu_item",
            active: true,
            tenant_id: TENANT,
          },
        ],
        restaurant_prices: [price("item-steak"), price("item-mojito")],
      }),
    );
    const catalog = await fetchSellableCatalog(sb, TENANT, {});
    const ids = catalog.items.map((i: any) => i.id);
    expect(ids).toContain("item-steak");
    expect(ids).toContain("item-mojito");
    const steak = catalog.items.find((i: any) => i.id === "item-steak") as any;
    const mojito = catalog.items.find((i: any) => i.id === "item-mojito") as any;
    expect(steak.station_id).toBe("st-kitchen");
    expect(mojito.station_id).toBe("st-bar");
  });

  it("4. an item on a draft (unpublished) menu does NOT appear", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menus: [menu("menu-draft", { status: "draft" })],
        restaurant_menu_items: [item("item-hidden", "menu-draft")],
        restaurant_prices: [price("item-hidden")],
      }),
    );
    const catalog = await fetchSellableCatalog(sb, TENANT, {});
    expect(catalog.items.map((i: any) => i.id)).not.toContain("item-hidden");
  });

  it("5. an item belonging to another tenant does NOT appear", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menus: [menu("menu-own"), menu("menu-other", { tenant_id: OTHER_TENANT })],
        restaurant_menu_items: [
          item("item-own", "menu-own"),
          item("item-other", "menu-other", { tenant_id: OTHER_TENANT }),
        ],
        restaurant_prices: [price("item-own"), price("item-other", { tenant_id: OTHER_TENANT })],
      }),
    );
    const catalog = await fetchSellableCatalog(sb, TENANT, {});
    const ids = catalog.items.map((i: any) => i.id);
    expect(ids).toContain("item-own");
    expect(ids).not.toContain("item-other");
  });

  it("6. a menu scoped to a different location does NOT leak into this location's catalogue, while a tenant-wide menu (location_id null) reaches every location", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menus: [
          menu("menu-loc1", { location_id: LOCATION }),
          menu("menu-loc2", { location_id: OTHER_LOCATION }),
          menu("menu-all-locations", { location_id: null }),
        ],
        restaurant_menu_items: [
          item("item-loc1-only", "menu-loc1"),
          item("item-loc2-only", "menu-loc2"),
          item("item-everywhere", "menu-all-locations"),
        ],
        restaurant_prices: [
          price("item-loc1-only"),
          price("item-loc2-only"),
          price("item-everywhere"),
        ],
      }),
    );
    const catalog = await fetchSellableCatalog(sb, TENANT, { locationId: LOCATION });
    const ids = catalog.items.map((i: any) => i.id);
    expect(ids).toContain("item-loc1-only");
    expect(ids).toContain("item-everywhere");
    expect(ids).not.toContain("item-loc2-only");
  });

  it("7. an item with no eligible price is still visible but marked not orderable, per the existing priceConfigured contract — never silently hidden, never sold at an unresolved price", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menus: [menu("menu-1")],
        restaurant_menu_items: [item("item-unpriced", "menu-1")],
        restaurant_prices: [],
      }),
    );
    const catalog = await fetchSellableCatalog(sb, TENANT, {});
    const it2 = catalog.items.find((i: any) => i.id === "item-unpriced") as any;
    expect(it2).toBeDefined();
    expect(it2.priceConfigured).toBe(false);
  });

  it("8. an explicit menuId still scopes to exactly that one menu (a future per-terminal selector keeps working)", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_menus: [menu("menu-a"), menu("menu-b")],
        restaurant_menu_items: [item("item-a", "menu-a"), item("item-b", "menu-b")],
        restaurant_prices: [price("item-a"), price("item-b")],
      }),
    );
    const catalog = await fetchSellableCatalog(sb, TENANT, { menuId: "menu-a" });
    const ids = catalog.items.map((i: any) => i.id);
    expect(ids).toEqual(["item-a"]);
  });
});
