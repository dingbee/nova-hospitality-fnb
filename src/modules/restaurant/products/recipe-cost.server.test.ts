/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Regression coverage for resolveRecipeCost — the versioned-recipe costing
 * engine (restaurant_recipes / restaurant_recipe_lines), authoritative for
 * Products & Recipes, Menu Economics and insertLines' pinned unit_cost.
 *
 * This is the exact engine behind the live "Classic Chicken Burger" defect:
 * a recipe costed at TZS 3,392,200 instead of ~TZS 4,591 because the
 * tenant's restaurant_inventory_units rows for g/kg/ml/l carried the wrong
 * dimension/factor (dimension='count', factor=1 for all of them — the
 * schema default), so componentToStock() saw g and kg as directly
 * comparable and used a 1:1 ratio. The engine's own maths were always
 * correct; this file pins that down so a future change to
 * resolveRecipeCost can't silently reintroduce a scaling bug on top of
 * correct unit data. There was previously no dedicated test file for this
 * module at all.
 */
import { describe, expect, it } from "vitest";
import { resolveRecipeCost, CircularRecipeError } from "./recipe-cost.server";

const TENANT = "tenant-1";

const UNIT_G = "unit-g";
const UNIT_KG = "unit-kg";
const UNIT_ML = "unit-ml";
const UNIT_L = "unit-l";
const UNIT_PC = "unit-pc";

const UNITS = [
  { id: UNIT_G, code: "g", name: "Gram", dimension: "mass", factor: 1 },
  { id: UNIT_KG, code: "kg", name: "Kilogram", dimension: "mass", factor: 1000 },
  { id: UNIT_ML, code: "ml", name: "Millilitre", dimension: "volume", factor: 1 },
  { id: UNIT_L, code: "l", name: "Litre", dimension: "volume", factor: 1000 },
  { id: UNIT_PC, code: "pc", name: "Piece", dimension: "count", factor: 1 },
];

function fakeDb(overrides: Partial<Record<string, any[]>> = {}) {
  const rows: Record<string, any[]> = {
    restaurant_recipes: [],
    restaurant_recipe_lines: [],
    restaurant_inventory_items: [],
    restaurant_inventory_units: UNITS,
    ...overrides,
  };
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
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filtered = filtered.filter((r) => set.has(r[col]));
        return api;
      },
      order() {
        return api;
      },
      single: async () => ({
        data: filtered[0] ?? null,
        error: filtered[0] ? null : { message: "not found" },
      }),
      then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
    };
    return api;
  }
  return { from, rows };
}

function recipe(id: string, over: Partial<Record<string, any>> = {}) {
  return {
    id,
    code: id,
    name: id,
    version: 1,
    currency: "TZS",
    yield_quantity: 1,
    target_cost: null,
    tenant_id: TENANT,
    ...over,
  };
}

function line(recipeId: string, over: Partial<Record<string, any>> = {}) {
  return {
    id: `${recipeId}-line-${Math.random()}`,
    tenant_id: TENANT,
    recipe_id: recipeId,
    component_kind: "inventory_item",
    inventory_item_id: null,
    sub_recipe_id: null,
    quantity: 1,
    unit_id: null,
    yield_percent: 100,
    is_optional: false,
    sort_order: 1,
    ...over,
  };
}

function item(id: string, over: Partial<Record<string, any>> = {}) {
  return { id, name: id, average_cost: 0, unit_id: null, tenant_id: TENANT, ...over };
}

describe("resolveRecipeCost", () => {
  it("converts KG -> G: a recipe line entered in grams against an item stocked (and priced) per kg costs at the gram-scaled rate, never the raw kg rate", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("r1", { yield_quantity: 1 })],
      restaurant_recipe_lines: [
        line("r1", { inventory_item_id: "chicken", quantity: 180, unit_id: UNIT_G }),
      ],
      restaurant_inventory_items: [item("chicken", { average_cost: 14000, unit_id: UNIT_KG })],
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "r1");
    expect(result.lines[0]!.lineCost).toBeCloseTo(2520, 4); // 0.18 kg * 14,000
    expect(result.ingredientCost).toBeCloseTo(2520, 4);
    expect(result.totalCost).toBeCloseTo(2520, 4);
    expect(result.unresolvedComponents).toBe(0);
  });

  it("converts L -> ML: a recipe line entered in ml against an item stocked per litre costs at the ml-scaled rate", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("r1")],
      restaurant_recipe_lines: [
        line("r1", { inventory_item_id: "oil", quantity: 15, unit_id: UNIT_ML }),
      ],
      restaurant_inventory_items: [item("oil", { average_cost: 7000, unit_id: UNIT_L })],
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "r1");
    expect(result.lines[0]!.lineCost).toBeCloseTo(105, 4); // 0.015 L * 7,000
  });

  it("PC -> PC: matching units need no conversion and price exactly as entered", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("r1")],
      restaurant_recipe_lines: [
        line("r1", { inventory_item_id: "bun", quantity: 1, unit_id: UNIT_PC }),
      ],
      restaurant_inventory_items: [item("bun", { average_cost: 1200, unit_id: UNIT_PC })],
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "r1");
    expect(result.lines[0]!.lineCost).toBe(1200);
  });

  it("the full Classic Chicken Burger UAT scenario: 8 ingredients, mixed g/ml/pc lines, sums to ~TZS 4,591 — never the ~738x-inflated total a units-dimension defect produces", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("ccb", { currency: "TZS", yield_quantity: 1 })],
      restaurant_recipe_lines: [
        line("ccb", { inventory_item_id: "chicken", quantity: 180, unit_id: UNIT_G }),
        line("ccb", { inventory_item_id: "bun", quantity: 1, unit_id: UNIT_PC }),
        line("ccb", { inventory_item_id: "lettuce", quantity: 25, unit_id: UNIT_G }),
        line("ccb", { inventory_item_id: "tomato", quantity: 40, unit_id: UNIT_G }),
        line("ccb", { inventory_item_id: "cheddar", quantity: 20, unit_id: UNIT_G }),
        line("ccb", { inventory_item_id: "mayo", quantity: 20, unit_id: UNIT_G }),
        line("ccb", { inventory_item_id: "oil", quantity: 15, unit_id: UNIT_ML }),
        line("ccb", { inventory_item_id: "salt", quantity: 3, unit_id: UNIT_G }),
      ],
      restaurant_inventory_items: [
        item("chicken", { average_cost: 14000, unit_id: UNIT_KG }),
        item("bun", { average_cost: 1200, unit_id: UNIT_PC }),
        item("lettuce", { average_cost: 4000, unit_id: UNIT_KG }),
        item("tomato", { average_cost: 3500, unit_id: UNIT_KG }),
        item("cheddar", { average_cost: 18000, unit_id: UNIT_KG }),
        item("mayo", { average_cost: 8000, unit_id: UNIT_KG }),
        item("oil", { average_cost: 7000, unit_id: UNIT_L }),
        item("salt", { average_cost: 2000, unit_id: UNIT_KG }),
      ],
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "ccb");
    expect(result.totalCost).toBeCloseTo(4591, 0);
    expect(result.costPerYieldUnit).toBeCloseTo(4591, 0);
    expect(result.unresolvedComponents).toBe(0);
  });

  it("applies yield_percent as trim/waste loss: a line with 80% yield needs proportionally more raw quantity, and costs proportionally more", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("r1")],
      restaurant_recipe_lines: [
        line("r1", {
          inventory_item_id: "fish",
          quantity: 100,
          unit_id: UNIT_G,
          yield_percent: 80,
        }),
      ],
      restaurant_inventory_items: [item("fish", { average_cost: 10, unit_id: UNIT_G })], // TZS 10/g
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "r1");
    // effective quantity = 100 / 0.8 = 125g -> 125 * 10 = 1250
    expect(result.lines[0]!.effectiveQuantity).toBeCloseTo(125, 4);
    expect(result.lines[0]!.lineCost).toBeCloseTo(1250, 4);
  });

  it("a dimensionally-incompatible line (e.g. a mass line against a volume-stocked item) is not costed and is flagged unresolved, never silently priced at the wrong scale", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("r1")],
      restaurant_recipe_lines: [
        line("r1", { inventory_item_id: "syrup", quantity: 50, unit_id: UNIT_G }),
      ],
      restaurant_inventory_items: [item("syrup", { average_cost: 5000, unit_id: UNIT_ML })],
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "r1");
    expect(result.lines[0]!.lineCost).toBe(0);
    expect(result.lines[0]!.unresolved).toBe(true);
    expect(result.lines[0]!.name).toContain("unit mismatch");
    expect(result.unresolvedComponents).toBe(1);
    expect(result.totalCost).toBe(0);
  });

  it("a line referencing an inventory item that no longer resolves is priced at zero and named 'Unmapped component' rather than throwing", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("r1")],
      restaurant_recipe_lines: [
        line("r1", { inventory_item_id: "deleted-item", quantity: 1, unit_id: UNIT_PC }),
      ],
      restaurant_inventory_items: [],
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "r1");
    expect(result.lines[0]!.name).toBe("Unmapped component");
    expect(result.lines[0]!.lineCost).toBe(0);
    expect(result.unresolvedComponents).toBe(1);
  });

  it("aggregates sub-recipe cost recursively, scaled by the parent line's quantity against the sub-recipe's own cost-per-yield-unit", async () => {
    const sb = fakeDb({
      restaurant_recipes: [
        recipe("sauce", { yield_quantity: 10, currency: "TZS" }), // yields 10 units for 1000 total -> 100/unit
        recipe("burger", { yield_quantity: 1 }),
      ],
      restaurant_recipe_lines: [
        line("sauce", { inventory_item_id: "ketchup", quantity: 1000, unit_id: UNIT_G }),
        line("burger", {
          component_kind: "sub_recipe",
          sub_recipe_id: "sauce",
          quantity: 2,
          unit_id: null,
        }),
      ],
      restaurant_inventory_items: [item("ketchup", { average_cost: 1, unit_id: UNIT_G })], // 1000g * 1 = 1000 total, /10 yield = 100/unit
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "burger");
    expect(result.subRecipeCost).toBeCloseTo(200, 4); // 2 * 100
    expect(result.totalCost).toBeCloseTo(200, 4);
  });

  it("refuses a circular sub-recipe dependency rather than looping or silently costing zero", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("a"), recipe("b")],
      restaurant_recipe_lines: [
        line("a", { component_kind: "sub_recipe", sub_recipe_id: "b" }),
        line("b", { component_kind: "sub_recipe", sub_recipe_id: "a" }),
      ],
    });
    await expect(resolveRecipeCost(sb as any, TENANT, "a")).rejects.toThrow(CircularRecipeError);
  });

  it("costPerYieldUnit divides total cost by the recipe's yield_quantity", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("r1", { yield_quantity: 4 })],
      restaurant_recipe_lines: [
        line("r1", { inventory_item_id: "x", quantity: 4, unit_id: UNIT_PC }),
      ],
      restaurant_inventory_items: [item("x", { average_cost: 100, unit_id: UNIT_PC })],
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "r1");
    expect(result.totalCost).toBe(400);
    expect(result.costPerYieldUnit).toBe(100);
  });

  it("reports targetVariance against a configured target_cost", async () => {
    const sb = fakeDb({
      restaurant_recipes: [recipe("r1", { target_cost: 5000 })],
      restaurant_recipe_lines: [
        line("r1", { inventory_item_id: "x", quantity: 1, unit_id: UNIT_PC }),
      ],
      restaurant_inventory_items: [item("x", { average_cost: 4591, unit_id: UNIT_PC })],
    });
    const result = await resolveRecipeCost(sb as any, TENANT, "r1");
    expect(result.targetCost).toBe(5000);
    expect(result.targetVariance).toBeCloseTo(-409, 0);
  });
});
