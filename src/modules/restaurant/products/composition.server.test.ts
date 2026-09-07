/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Regression coverage for the Menu Economics closure: composition.server.ts
 * (composed/bar beverage costing + servings-available) was the one costing
 * path in this codebase that never converted a recipe line's quantity into
 * the inventory item's own stock unit before pricing or depleting it —
 * every other path (recipe-cost.server.ts, costing.server.ts) already used
 * componentToStock() for exactly this. A cocktail recipe entered in `ml`
 * against a bottle stocked in `l` would have cost 1000x too much and
 * reported 1000x too few servings available.
 */
import { describe, expect, it, vi } from "vitest";
import { getMenuItemComposition } from "./composition.server";

vi.mock("../core/access.server", () => ({
  assertTenantRead: vi.fn().mockResolvedValue(undefined),
}));

const TENANT = "tenant-1";
const MENU_ITEM = "menu-item-1";
const PRODUCT = "product-1";
const RECIPE = "recipe-1";

const UNIT_ML = "unit-ml";
const UNIT_L = "unit-l";
const UNIT_PC = "unit-pc";

const ITEM_GIN = "item-gin"; // stocked in litres, recipe line in ml
const ITEM_LIME = "item-lime"; // stocked and used in the same unit (pc)
const ITEM_BITTERS = "item-bitters"; // recipe line in a dimensionally-incompatible unit

function fakeDb(rows: Record<string, any[]>) {
  function from(table: string) {
    let filtered = rows[table] ?? [];
    const api: any = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return api;
      },
      not(col: string, _op: string, _val: unknown) {
        filtered = filtered.filter((r) => r[col] != null);
        return api;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filtered = filtered.filter((r) => set.has(r[col]));
        return api;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        const asc = opts?.ascending !== false;
        filtered = [...filtered].sort(
          (a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1),
        );
        return api;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return api;
      },
      maybeSingle: async () => ({ data: filtered[0] ?? null }),
      single: async () => ({
        data: filtered[0] ?? null,
        error: filtered[0] ? null : { message: "not found" },
      }),
      then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
    };
    return api;
  }
  return { from };
}

function baseRows(overrides: Partial<Record<string, any[]>> = {}) {
  return {
    restaurant_products: [
      {
        id: PRODUCT,
        tenant_id: TENANT,
        menu_item_id: MENU_ITEM,
        recipe_id: RECIPE,
        active: true,
      },
    ],
    restaurant_recipes: [
      {
        id: RECIPE,
        tenant_id: TENANT,
        lineage_id: RECIPE,
        version: 1,
        status: "active",
        yield_quantity: 1,
        produces_inventory_item_id: null,
      },
    ],
    restaurant_inventory_units: [
      { id: UNIT_ML, code: "ml", name: "ML", dimension: "volume", factor: 1 },
      { id: UNIT_L, code: "l", name: "L", dimension: "volume", factor: 1000 },
      { id: UNIT_PC, code: "pc", name: "Piece", dimension: "count", factor: 1 },
    ],
    ...overrides,
  };
}

describe("getMenuItemComposition — unit conversion", () => {
  it("converts a recipe line entered in a different-but-compatible unit than the item's stock unit before costing it", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_recipe_lines: [
          {
            id: "line-gin",
            tenant_id: TENANT,
            recipe_id: RECIPE,
            component_kind: "inventory_item",
            inventory_item_id: ITEM_GIN,
            sub_recipe_id: null,
            quantity: 50, // 50 ml
            unit_id: UNIT_ML,
            yield_percent: 100,
            is_optional: false,
            sort_order: 1,
          },
        ],
        restaurant_inventory_items: [
          {
            id: ITEM_GIN,
            name: "Gin",
            sku: "GIN-01",
            current_quantity: 2, // 2 litres on hand
            average_cost: 30000, // TZS 30,000 per litre
            currency: "TZS",
            is_beverage: true,
            unit_id: UNIT_L,
          },
        ],
      }),
    );

    const result = await getMenuItemComposition(sb, "user-1", {
      tenantId: TENANT,
      menuItemId: MENU_ITEM,
    });

    expect(result.composed).toBe(true);
    // 50 ml = 0.05 L; 0.05 L * 30,000/L = 1,500 — never 50 * 30,000 = 1,500,000.
    expect(result.cost).toBeCloseTo(1500, 4);
    // 2 L on hand / 0.05 L per serving = 40 servings — never 2 / 50 = 0.
    expect(result.servings).toBe(40);
    const gin = result.components.find((c: any) => c.inventoryItemId === ITEM_GIN);
    expect(gin?.unresolved).toBe(false);
  });

  it("a recipe line already in the item's own stock unit needs no conversion and is unaffected", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_recipe_lines: [
          {
            id: "line-lime",
            tenant_id: TENANT,
            recipe_id: RECIPE,
            component_kind: "inventory_item",
            inventory_item_id: ITEM_LIME,
            sub_recipe_id: null,
            quantity: 2,
            unit_id: UNIT_PC,
            yield_percent: 100,
            is_optional: false,
            sort_order: 1,
          },
        ],
        restaurant_inventory_items: [
          {
            id: ITEM_LIME,
            name: "Lime wedge",
            sku: "LIME-01",
            current_quantity: 20,
            average_cost: 200,
            currency: "TZS",
            is_beverage: false,
            unit_id: UNIT_PC,
          },
        ],
      }),
    );

    const result = await getMenuItemComposition(sb, "user-1", {
      tenantId: TENANT,
      menuItemId: MENU_ITEM,
    });

    expect(result.cost).toBeCloseTo(400, 4); // 2 * 200
    expect(result.servings).toBe(10); // 20 / 2
  });

  it("a dimensionally-incompatible line (e.g. a volume component costed against a count-dimension line unit) is excluded from cost/servings math and flagged, never silently mispriced", async () => {
    const sb = fakeDb(
      baseRows({
        restaurant_recipe_lines: [
          {
            id: "line-bitters",
            tenant_id: TENANT,
            recipe_id: RECIPE,
            component_kind: "inventory_item",
            inventory_item_id: ITEM_BITTERS,
            sub_recipe_id: null,
            quantity: 2,
            unit_id: UNIT_PC, // dashes counted by "piece", but the item is stocked in ml
            yield_percent: 100,
            is_optional: false,
            sort_order: 1,
          },
        ],
        restaurant_inventory_items: [
          {
            id: ITEM_BITTERS,
            name: "Bitters",
            sku: "BIT-01",
            current_quantity: 100,
            average_cost: 50,
            currency: "TZS",
            is_beverage: true,
            unit_id: UNIT_ML,
          },
        ],
      }),
    );

    const result = await getMenuItemComposition(sb, "user-1", {
      tenantId: TENANT,
      menuItemId: MENU_ITEM,
    });

    expect(result.cost).toBe(0);
    const bitters = result.components.find((c: any) => c.inventoryItemId === ITEM_BITTERS);
    expect(bitters?.unresolved).toBe(true);
    // The raw, un-converted quantity is still shown for staff to see what's blocking it.
    expect(bitters?.quantityPerServing).toBe(2);
  });
});
