/* eslint-disable @typescript-eslint/no-explicit-any -- minimal fake Supabase rows. */
import { describe, expect, it } from "vitest";
import { filterGuestComposedItems, ingredientBackedMenuItemIds } from "./guest-composition.server";

const T = "tenant-1";

function fakeSb(rows: Record<string, any[]>, failTable?: string) {
  const calls: string[] = [];
  return {
    calls,
    from(table: string) {
      calls.push(table);
      let filtered = rows[table] ?? [];
      const builder: any = {
        select: () => builder,
        eq(col: string, val: unknown) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          const accepted = new Set(vals);
          filtered = filtered.filter((r) => accepted.has(r[col]));
          return builder;
        },
        then: (resolve: (v: any) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(
            failTable === table
              ? { data: null, error: { message: "boom" } }
              : { data: filtered, error: null },
          ).then(resolve, reject),
      };
      return builder;
    },
  };
}

const recipe = (id: string, extra: Record<string, unknown> = {}) => ({
  tenant_id: T,
  id,
  lineage_id: id,
  version: 1,
  status: "active",
  ...extra,
});
const line = (recipe_id: string, extra: Record<string, unknown>) => ({
  tenant_id: T,
  recipe_id,
  inventory_item_id: null,
  sub_recipe_id: null,
  quantity: 1,
  ...extra,
});
const product = (
  menu_item_id: string,
  recipe_id: string | null,
  extra: Record<string, unknown> = {},
) => ({
  tenant_id: T,
  menu_item_id,
  recipe_id,
  active: true,
  ...extra,
});

describe("ingredientBackedMenuItemIds — guest-only composition gate", () => {
  it("configured: a versioned recipe with a positive ingredient line is visible", async () => {
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1")],
      restaurant_recipes: [recipe("r1")],
      restaurant_recipe_lines: [line("r1", { inventory_item_id: "inv-1", quantity: 0.25 })],
    });
    expect([...(await ingredientBackedMenuItemIds(sb, T, ["m1"]))]).toEqual(["m1"]);
  });

  it("configured: legacy direct composition (restaurant_recipe_components) is visible", async () => {
    const sb = fakeSb({
      restaurant_recipe_components: [
        { tenant_id: T, menu_item_id: "m1", inventory_item_id: "inv-1", quantity: 2 },
      ],
    });
    expect([...(await ingredientBackedMenuItemIds(sb, T, ["m1"]))]).toEqual(["m1"]);
  });

  it("unconfigured: no product recipe and no components is hidden", async () => {
    const sb = fakeSb({ restaurant_products: [product("m1", null)] });
    expect((await ingredientBackedMenuItemIds(sb, T, ["m1"])).size).toBe(0);
  });

  it("unconfigured: a recipe with no lines is hidden", async () => {
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1")],
      restaurant_recipes: [recipe("r1")],
    });
    expect((await ingredientBackedMenuItemIds(sb, T, ["m1"])).size).toBe(0);
  });

  it("partially configured: only zero-quantity ingredient lines are hidden", async () => {
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1")],
      restaurant_recipes: [recipe("r1")],
      restaurant_recipe_lines: [line("r1", { inventory_item_id: "inv-1", quantity: 0 })],
      restaurant_recipe_components: [
        { tenant_id: T, menu_item_id: "m1", inventory_item_id: "inv-2", quantity: 0 },
        {
          tenant_id: T,
          menu_item_id: "m1",
          inventory_item_id: null,
          component_menu_item_id: "m9",
          quantity: 1,
        },
      ],
    });
    expect((await ingredientBackedMenuItemIds(sb, T, ["m1"])).size).toBe(0);
  });

  it("partially configured: a recipe pointing only at an empty sub-recipe is hidden", async () => {
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1")],
      restaurant_recipes: [recipe("r1"), recipe("sub")],
      restaurant_recipe_lines: [line("r1", { sub_recipe_id: "sub", quantity: 1 })],
    });
    expect((await ingredientBackedMenuItemIds(sb, T, ["m1"])).size).toBe(0);
  });

  it("partially configured: one valid ingredient line among incomplete ones is visible", async () => {
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1")],
      restaurant_recipes: [recipe("r1"), recipe("sub")],
      restaurant_recipe_lines: [
        line("r1", { sub_recipe_id: "sub", quantity: 1 }),
        line("r1", { inventory_item_id: "inv-1", quantity: 0 }),
        line("r1", { inventory_item_id: "inv-2", quantity: 3 }),
      ],
    });
    expect([...(await ingredientBackedMenuItemIds(sb, T, ["m1"]))]).toEqual(["m1"]);
  });

  it("nested: ingredients reached only through two levels of sub-recipe are visible, and cycles terminate", async () => {
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1")],
      restaurant_recipes: [recipe("r1"), recipe("r2"), recipe("r3")],
      restaurant_recipe_lines: [
        line("r1", { sub_recipe_id: "r2" }),
        line("r2", { sub_recipe_id: "r3" }),
        line("r3", { sub_recipe_id: "r1" }),
        line("r3", { inventory_item_id: "inv-1", quantity: 1 }),
      ],
    });
    expect([...(await ingredientBackedMenuItemIds(sb, T, ["m1"]))]).toEqual(["m1"]);
  });

  it("follows the lineage to today's active version, matching sales consumption (activeRecipeForMenuItem)", async () => {
    // Product still pins v1 (archived, had ingredients); v2 is active with none.
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1v1")],
      restaurant_recipes: [
        recipe("r1v1", { lineage_id: "L1", version: 1, status: "archived" }),
        recipe("r1v2", { lineage_id: "L1", version: 2, status: "active" }),
      ],
      restaurant_recipe_lines: [line("r1v1", { inventory_item_id: "inv-1", quantity: 1 })],
    });
    expect((await ingredientBackedMenuItemIds(sb, T, ["m1"])).size).toBe(0);
  });

  it("a pinned recipe with no active version in its lineage is hidden", async () => {
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1")],
      restaurant_recipes: [recipe("r1", { status: "draft" })],
      restaurant_recipe_lines: [line("r1", { inventory_item_id: "inv-1", quantity: 1 })],
    });
    expect((await ingredientBackedMenuItemIds(sb, T, ["m1"])).size).toBe(0);
  });

  it("inactive products do not count", async () => {
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1", { active: false })],
      restaurant_recipes: [recipe("r1")],
      restaurant_recipe_lines: [line("r1", { inventory_item_id: "inv-1", quantity: 1 })],
    });
    expect((await ingredientBackedMenuItemIds(sb, T, ["m1"])).size).toBe(0);
  });

  it("tenant isolation: another tenant's composition never makes this tenant's item visible", async () => {
    const sb = fakeSb({
      restaurant_products: [product("m1", "r1", { tenant_id: "tenant-2" })],
      restaurant_recipes: [recipe("r1", { tenant_id: "tenant-2" })],
      restaurant_recipe_lines: [line("r1", { tenant_id: "tenant-2", inventory_item_id: "inv-1" })],
      restaurant_recipe_components: [
        { tenant_id: "tenant-2", menu_item_id: "m1", inventory_item_id: "inv-1", quantity: 1 },
      ],
    });
    expect((await ingredientBackedMenuItemIds(sb, T, ["m1"])).size).toBe(0);
  });

  it("fails closed when configuration cannot be read", async () => {
    const sb = fakeSb(
      { restaurant_products: [product("m1", "r1")] },
      "restaurant_recipe_components",
    );
    await expect(ingredientBackedMenuItemIds(sb, T, ["m1"])).rejects.toThrow(
      /could not be verified/,
    );
  });

  it("no ids → no queries", async () => {
    const sb = fakeSb({});
    expect((await ingredientBackedMenuItemIds(sb, T, [])).size).toBe(0);
    expect(sb.calls).toEqual([]);
  });
});

describe("filterGuestComposedItems", () => {
  it("keeps configured, drops unconfigured and preserves catalogue order", async () => {
    const sb = fakeSb({
      restaurant_products: [product("b", "r1"), product("c", "r1")],
      restaurant_recipes: [recipe("r1")],
      restaurant_recipe_lines: [line("r1", { inventory_item_id: "inv-1" })],
      restaurant_recipe_components: [
        { tenant_id: T, menu_item_id: "a", inventory_item_id: "inv-2", quantity: 1 },
      ],
    });
    const items = [{ id: "c" }, { id: "x" }, { id: "a" }, { id: "b" }];
    expect((await filterGuestComposedItems(sb, T, items)).map((i) => i.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});
