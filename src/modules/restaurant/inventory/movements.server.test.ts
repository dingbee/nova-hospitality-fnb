/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * Pre-freeze cleanup — costing integrity.
 *
 * consumeForOrderItem is restaurant_recipe_components' live, end-to-end
 * consumption path (see import/domains.ts's own note on which recipe
 * system is actually read at order-close). It used to multiply a recipe
 * component's quantity directly by the item's average_cost with no unit
 * conversion, so a component written in grams against a KG-stocked item
 * was costed — and deducted from stock — as if it were whole kilograms.
 * Fixed by converting through units.ts#componentToStock before either
 * number is used.
 */
import { describe, expect, it } from "vitest";
import { consumeForOrderItem } from "./movements.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

const KG = { id: "unit-kg", code: "KG", name: "Kilogram", dimension: "mass", factor: 1000 };
const G = { id: "unit-g", code: "G", name: "Gram", dimension: "mass", factor: 1 };
const PC = { id: "unit-pc", code: "PC", name: "Piece", dimension: "count", factor: 1 };

function makeFakeSupabase(opts: { items: any[]; components: any[]; units: any[] }) {
  const movements: any[] = [];
  let seq = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};

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
        (api as any)._insertRow = row;
        return api;
      },
      single: () => resolve(true),
      maybeSingle: () => resolve(false),
      then: (onFulfilled: any, onRejected: any) => resolve(false).then(onFulfilled, onRejected),
    };

    async function resolve(isSingleInsert: boolean) {
      if (table === "restaurant_recipe_components") {
        const rows = opts.components.filter((c) => c.menu_item_id === filters.menu_item_id);
        return { data: rows, error: null };
      }
      if (table === "restaurant_inventory_items") {
        if ((api as any)._insertRow) return { data: null, error: null }; // not used
        if (inFilters.id) {
          return { data: opts.items.filter((i) => inFilters.id!.includes(i.id)), error: null };
        }
        const row = opts.items.find((i) => i.id === filters.id) ?? null;
        return { data: row, error: null };
      }
      if (table === "restaurant_inventory_units") {
        return { data: opts.units.filter((u) => inFilters.id?.includes(u.id)), error: null };
      }
      if (table === "restaurant_stock_movements") {
        const row = (api as any)._insertRow;
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

describe("consumeForOrderItem — recipe component costing and unit conversion", () => {
  it("converts a gram recipe component against a KG-stocked item before costing or deducting stock", async () => {
    const fake = makeFakeSupabase({
      items: [
        {
          id: "item-chicken",
          name: "Chicken Breast",
          average_cost: 14000, // TZS per KG
          currency: "TZS",
          unit_id: KG.id,
          allow_negative: true,
          current_quantity: 100,
        },
      ],
      components: [
        {
          id: "comp-1",
          menu_item_id: "menu-burger",
          inventory_item_id: "item-chicken",
          quantity: 180, // grams, per the spec's own worked example
          unit_id: G.id,
          yield_percent: 100,
        },
      ],
      units: [KG, G],
    });

    const cost = await consumeForOrderItem(fake.supabase, USER, {
      tenantId: TENANT,
      orderId: "order-1",
      orderItemId: "item-1",
      menuItemId: "menu-burger",
      quantity: 1,
    });

    // 180 g @ TZS 14,000/KG = 0.18 KG × 14,000 = TZS 2,520 — never
    // 180 × 14,000 = TZS 2,520,000, the pre-fix (uncoverted) result.
    expect(cost).toBe(2520);
    expect(fake.movements).toHaveLength(1);
    expect(fake.movements[0].quantity).toBeCloseTo(-0.18, 6); // stock deducted in KG, not grams
    expect(fake.movements[0].unit_cost).toBe(14000);
  });

  it("scales correctly for multiple units sold (Classic Chicken Burger x2 -> 360g)", async () => {
    const fake = makeFakeSupabase({
      items: [
        {
          id: "item-chicken",
          name: "Chicken Breast",
          average_cost: 14000,
          currency: "TZS",
          unit_id: KG.id,
          allow_negative: true,
          current_quantity: 100,
        },
      ],
      components: [
        {
          id: "comp-1",
          menu_item_id: "menu-burger",
          inventory_item_id: "item-chicken",
          quantity: 180,
          unit_id: G.id,
          yield_percent: 100,
        },
      ],
      units: [KG, G],
    });

    const cost = await consumeForOrderItem(fake.supabase, USER, {
      tenantId: TENANT,
      orderId: "order-1",
      orderItemId: "item-1",
      menuItemId: "menu-burger",
      quantity: 2,
    });

    expect(cost).toBe(5040); // 2 x 2520
    expect(fake.movements[0].quantity).toBeCloseTo(-0.36, 6); // 360 g -> 0.36 KG
  });

  it("needs no conversion when the component is already written in the item's own stock unit (e.g. PC)", async () => {
    const fake = makeFakeSupabase({
      items: [
        {
          id: "item-bun",
          name: "Burger Bun",
          average_cost: 400,
          currency: "TZS",
          unit_id: PC.id,
          allow_negative: true,
          current_quantity: 100,
        },
      ],
      components: [
        {
          id: "comp-2",
          menu_item_id: "menu-burger",
          inventory_item_id: "item-bun",
          quantity: 1,
          unit_id: PC.id,
          yield_percent: 100,
        },
      ],
      units: [PC],
    });

    const cost = await consumeForOrderItem(fake.supabase, USER, {
      tenantId: TENANT,
      orderId: "order-1",
      orderItemId: "item-1",
      menuItemId: "menu-burger",
      quantity: 2,
    });

    expect(cost).toBe(800);
    expect(fake.movements[0].quantity).toBe(-2);
  });

  it("refuses to close an order line whose component unit cannot be converted to the item's stock unit, rather than miscosting it", async () => {
    const fake = makeFakeSupabase({
      items: [
        {
          id: "item-chicken",
          name: "Chicken Breast",
          average_cost: 14000,
          currency: "TZS",
          unit_id: PC.id, // deliberately mismatched dimension
          allow_negative: true,
          current_quantity: 100,
        },
      ],
      components: [
        {
          id: "comp-1",
          menu_item_id: "menu-burger",
          inventory_item_id: "item-chicken",
          quantity: 180,
          unit_id: G.id,
          yield_percent: 100,
        },
      ],
      units: [G, PC],
    });

    await expect(
      consumeForOrderItem(fake.supabase, USER, {
        tenantId: TENANT,
        orderId: "order-1",
        orderItemId: "item-1",
        menuItemId: "menu-burger",
        quantity: 1,
      }),
    ).rejects.toThrow(/cannot be converted/i);
    expect(fake.movements).toHaveLength(0); // nothing posted on refusal
  });
});
