/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * Pre-freeze cleanup — costing integrity (read/preview path).
 *
 * computeRecipeCost is the theoretical recipe-cost preview shown against a
 * menu item (margin, target-cost variance). It shared the same missing-
 * unit-conversion defect as the write-side consumption path: a component
 * entered in grams against a KG-stocked item priced its line as if 180 g
 * cost as much as 180 kg. Unlike the write path this is a read/display
 * surface, so a mismatch degrades that one line to an explicit, flagged
 * "not costed" rather than blocking the whole preview.
 */
import { describe, expect, it } from "vitest";
import { computeRecipeCost } from "./costing.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

const KG = { id: "unit-kg", code: "KG", name: "Kilogram", dimension: "mass", factor: 1000 };
const G = { id: "unit-g", code: "G", name: "Gram", dimension: "mass", factor: 1 };
const PC = { id: "unit-pc", code: "PC", name: "Piece", dimension: "count", factor: 1 };

function makeFakeSupabase(opts: { item: any; components: any[]; units: any[] }) {
  const inserted: any[] = [];

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let insertRow: any;

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
        insertRow = row;
        return api;
      },
      single: () => resolve(),
      then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
    };

    async function resolve() {
      if (table === "restaurant_members")
        return { data: [{ tenant_id: TENANT, user_id: USER, role: "owner" }], error: null };
      if (table === "restaurant_menu_items") return { data: opts.item, error: null };
      if (table === "restaurant_recipe_components") return { data: opts.components, error: null };
      if (table === "restaurant_inventory_items")
        return { data: [opts.item.__inventoryItem].filter(Boolean), error: null };
      if (table === "restaurant_inventory_units")
        return { data: opts.units.filter((u) => inFilters.id?.includes(u.id)), error: null };
      if (table === "restaurant_recipe_costs") {
        inserted.push(insertRow);
        return { data: { id: "cost-1", computed_at: "2026-01-01T00:00:00Z" }, error: null };
      }
      return { data: null, error: null };
    }

    return api;
  }

  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: async (fn: string) => {
        if (fn === "has_any_role") return { data: false, error: null };
        return { data: null, error: null };
      },
    },
    inserted,
  };
}

describe("computeRecipeCost — unit conversion before pricing", () => {
  it("prices a gram-denominated component against its KG-stocked item correctly (180g @ 14,000/KG = 2,520)", async () => {
    const item = {
      id: "menu-burger",
      name: "Classic Chicken Burger",
      price: 18000,
      currency: "TZS",
      __inventoryItem: {
        id: "item-chicken",
        name: "Chicken Breast",
        average_cost: 14000,
        unit_id: KG.id,
      },
    };
    const fake = makeFakeSupabase({
      item,
      components: [
        {
          quantity: 180,
          yield_percent: 100,
          inventory_item_id: "item-chicken",
          unit_id: G.id,
        },
      ],
      units: [KG, G],
    });

    const result = await computeRecipeCost(fake.supabase, USER, {
      tenantId: TENANT,
      menuItemId: "menu-burger",
      overheadCost: 0,
    } as any);

    expect(result.ingredientCost).toBe(2520);
    expect(result.breakdown[0]).toMatchObject({ unit_cost: 14000, line_cost: 2520 });
  });

  it("flags a genuine unit mismatch as not-costed instead of miscosting the line", async () => {
    const item = {
      id: "menu-burger",
      name: "Classic Chicken Burger",
      price: 18000,
      currency: "TZS",
      __inventoryItem: {
        id: "item-chicken",
        name: "Chicken Breast",
        average_cost: 14000,
        unit_id: PC.id, // deliberately mismatched dimension
      },
    };
    const fake = makeFakeSupabase({
      item,
      components: [
        {
          quantity: 180,
          yield_percent: 100,
          inventory_item_id: "item-chicken",
          unit_id: G.id,
        },
      ],
      units: [G, PC],
    });

    const result = await computeRecipeCost(fake.supabase, USER, {
      tenantId: TENANT,
      menuItemId: "menu-burger",
      overheadCost: 0,
    } as any);

    expect(result.ingredientCost).toBe(0);
    expect(result.breakdown[0].line_cost).toBe(0);
    expect(result.breakdown[0].name).toMatch(/unit mismatch/i);
  });
});
