/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * ME-05 inventory integrity certification — `consumeForRecipeSale`'s
 * sub-recipe explosion.
 *
 * Before this pass: exploding a childless sub-recipe (one with no
 * `produces_inventory_item_id`, so its own ingredients are consumed
 * directly) keyed each resulting ledger movement as `${subRecipeId}:${lineId}`
 * — identical regardless of which PARENT line referenced the sub-recipe. A
 * parent recipe referencing the same childless sub-recipe from two distinct
 * lines (e.g. "bun spread" and "dip on the side", both pointing at a shared
 * "House Sauce" sub-recipe) produced two demand entries for the same
 * sub-recipe ingredient with the SAME dedupe key — the second `insertMovement`
 * call hit the `UNIQUE(tenant_id, dedupe_key)` constraint, was silently
 * treated as "already applied" (the established, correct behavior for a
 * genuine duplicate), and its ledger write was dropped even though it
 * represented real, distinct demand. Net effect: silent under-consumption
 * whenever a recipe references the same childless sub-recipe more than once.
 */
import { describe, expect, it } from "vitest";
import { consumeForRecipeSale } from "./consumption.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const BURGER_RECIPE = "33333333-3333-3333-3333-333333333333";
const SAUCE_RECIPE = "44444444-4444-4444-4444-444444444444";
const LINE_BUN_SPREAD = "55555555-5555-5555-5555-555555555555";
const LINE_DIP = "66666666-6666-6666-6666-666666666666";
const SAUCE_LINE_TOMATO = "77777777-7777-7777-7777-777777777777";
const TOMATO_ITEM = "88888888-8888-8888-8888-888888888888";

function makeFakeSupabase() {
  const recipes: Record<string, any> = {
    [BURGER_RECIPE]: { id: BURGER_RECIPE, yield_quantity: 1, produces_inventory_item_id: null },
    [SAUCE_RECIPE]: { id: SAUCE_RECIPE, yield_quantity: 1, produces_inventory_item_id: null },
  };
  const linesByRecipe: Record<string, any[]> = {
    [BURGER_RECIPE]: [
      {
        id: LINE_BUN_SPREAD,
        component_kind: "sub_recipe",
        inventory_item_id: null,
        sub_recipe_id: SAUCE_RECIPE,
        quantity: 1, // 1x sauce yield for the bun spread
        unit_id: null,
        yield_percent: 100,
      },
      {
        id: LINE_DIP,
        component_kind: "sub_recipe",
        inventory_item_id: null,
        sub_recipe_id: SAUCE_RECIPE,
        quantity: 2, // 2x sauce yield for the side dip
        unit_id: null,
        yield_percent: 100,
      },
    ],
    [SAUCE_RECIPE]: [
      {
        id: SAUCE_LINE_TOMATO,
        component_kind: "inventory_item",
        inventory_item_id: TOMATO_ITEM,
        sub_recipe_id: null,
        quantity: 10, // 10 units of Tomato Base per 1x sauce yield
        unit_id: null,
        yield_percent: 100,
      },
    ],
  };
  const tomatoItem = {
    id: TOMATO_ITEM,
    name: "Tomato Base",
    average_cost: 50,
    currency: "TZS",
    location_id: null,
    property_id: null,
    unit_id: null,
    content_per_stock_unit: null,
    content_unit_id: null,
    current_quantity: 1000,
    allow_negative: false,
  };
  const movements: any[] = [];
  let seq = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let op: "select" | "insert" = "select";
    let payload: any;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        inFilters[col] = vals;
        return api;
      },
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return api;
      },
      single: () => resolve(true),
      maybeSingle: () => resolve(false),
      then: (onFulfilled: any, onRejected: any) => resolve(false).then(onFulfilled, onRejected),
    };

    async function resolve(isSingleInsert: boolean) {
      if (table === "restaurant_recipes" && op === "select") {
        const id = filters.id as string;
        return { data: recipes[id] ?? null, error: null };
      }
      if (table === "restaurant_recipe_lines" && op === "select") {
        const recipeId = filters.recipe_id as string;
        return { data: linesByRecipe[recipeId] ?? [], error: null };
      }
      if (table === "restaurant_inventory_items" && op === "select") {
        if (inFilters.id) {
          return { data: [tomatoItem].filter((i) => inFilters.id!.includes(i.id)), error: null };
        }
        if (filters.id) {
          return { data: filters.id === tomatoItem.id ? tomatoItem : null, error: null };
        }
        return { data: [tomatoItem], error: null };
      }
      if (table === "restaurant_inventory_units" && op === "select") {
        return { data: [], error: null };
      }
      if (table === "restaurant_stock_movements" && op === "insert") {
        const row = payload;
        if (row.dedupe_key && movements.some((m) => m.dedupe_key === row.dedupe_key)) {
          return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        seq += 1;
        const stored = { ...row, id: `mv-${seq}`, balance_after: 0 };
        movements.push(stored);
        return isSingleInsert ? { data: stored, error: null } : { data: [stored], error: null };
      }
      return { data: null, error: null };
    }

    return api;
  }

  return {
    supabase: { from: (table: string) => builder(table) },
    movements,
  };
}

describe("consumeForRecipeSale — dedupe-key uniqueness when the same childless sub-recipe is referenced twice", () => {
  it("posts two separate consumption movements for the shared sub-recipe's ingredient, not one dropped as a duplicate", async () => {
    const fake = makeFakeSupabase();
    const cost = await consumeForRecipeSale(fake.supabase as any, USER, {
      tenantId: TENANT,
      orderId: "order-1",
      orderItemId: "item-1",
      recipeId: BURGER_RECIPE,
      quantity: 1,
    });

    // Two distinct demand lines for Tomato Base: 10 (bun spread, 1x) and 20
    // (dip, 2x) — both must post, with different dedupe keys.
    expect(fake.movements).toHaveLength(2);
    const keys = fake.movements.map((m) => m.dedupe_key);
    expect(new Set(keys).size).toBe(2); // no collision
    const quantities = fake.movements.map((m) => Number(m.quantity)).sort((a, b) => a - b);
    expect(quantities).toEqual([-20, -10].sort((a, b) => a - b));
    // Total Tomato Base consumed: 30 units @ 50 TZS = 1500, not 1000 (which
    // is what a dropped second movement would have produced: 10 units only).
    expect(cost).toBe(1500);
  });

  it("is still idempotent on a genuine retry — the same order item processed twice never doubles either movement", async () => {
    const fake = makeFakeSupabase();
    const args = {
      tenantId: TENANT,
      orderId: "order-1",
      orderItemId: "item-1",
      recipeId: BURGER_RECIPE,
      quantity: 1,
    };
    await consumeForRecipeSale(fake.supabase as any, USER, args);
    await consumeForRecipeSale(fake.supabase as any, USER, args);
    expect(fake.movements).toHaveLength(2); // still exactly two, not four
  });
});
