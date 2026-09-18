/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * ME-05 inventory integrity certification — production input unit conversion.
 *
 * Before this pass: `startProduction` built `restaurant_production_inputs`
 * rows straight from `RecipeCostLine.effectiveQuantity`, which is in the
 * recipe line's own DECLARED unit (e.g. grams) — never converted to the
 * referenced item's STOCK unit (e.g. kilograms), unlike every other
 * consumption path in this codebase (`consumeForOrderItem`,
 * `consumeForRecipeSale`, `postGoodsReceipt`, all of which call
 * `componentToStock`/`convertUnits` before touching the ledger).
 * `completeProduction` then posted that unconverted number straight to the
 * ledger as a `consumption` movement — a recipe line written in grams
 * against a kilogram-stocked item deducted the gram figure as whole
 * kilograms, a 1000x over-consumption.
 */
import { describe, expect, it } from "vitest";
import { completeProduction, startProduction } from "./production.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const RECIPE = "33333333-3333-3333-3333-333333333333";
const RECIPE_LINE = "44444444-4444-4444-4444-444444444444";
const FLOUR_ITEM = "55555555-5555-5555-5555-555555555555";
const BREAD_ITEM = "66666666-6666-6666-6666-666666666666";
const GRAM_UNIT = "unit-gram";
const KG_UNIT = "unit-kg";

const GRAM = { id: GRAM_UNIT, code: "G", name: "Gram", dimension: "mass", factor: 1 };
const KG = { id: KG_UNIT, code: "KG", name: "Kilogram", dimension: "mass", factor: 1000 };
const COUNT_UNIT = { id: "unit-count", code: "PC", name: "Piece", dimension: "count", factor: 1 };

function makeFakeSupabase(opts: { lineUnitId?: string; extraUnits?: Array<typeof GRAM> } = {}) {
  const recipe = {
    id: RECIPE,
    code: "BREAD-1",
    name: "White Bread",
    version: 1,
    status: "active",
    yield_quantity: 1,
    currency: "TZS",
    produces_inventory_item_id: BREAD_ITEM,
    target_cost: null,
  };
  const recipeLines = [
    {
      id: RECIPE_LINE,
      component_kind: "inventory_item",
      inventory_item_id: FLOUR_ITEM,
      sub_recipe_id: null,
      quantity: 500, // 500 GRAMS of flour per batch, per the recipe
      unit_id: opts.lineUnitId ?? GRAM_UNIT,
      yield_percent: 100,
      is_optional: false,
      sort_order: 1,
    },
  ];
  const units = [GRAM, KG, ...(opts.extraUnits ?? [])];
  const flourItem = {
    id: FLOUR_ITEM,
    name: "Flour",
    average_cost: 5000, // TZS per KILOGRAM — the item's stock unit
    unit_id: KG_UNIT,
    content_per_stock_unit: null,
    content_unit_id: null,
    current_quantity: 100,
  };
  const productions: Record<string, any> = {};
  const productionInputs: Record<string, any> = {};
  const movements: any[] = [];
  let seq = 0;

  function applyMovement(row: any) {
    if (row.dedupe_key && movements.some((m) => m.dedupe_key === row.dedupe_key)) {
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    }
    // Only the flour item's balance is tracked here — the production
    // output movement (for BREAD_ITEM) must not perturb it.
    let balanceAfter = flourItem.current_quantity;
    if (row.inventory_item_id === FLOUR_ITEM) {
      flourItem.current_quantity = Number(
        (flourItem.current_quantity + Number(row.quantity)).toFixed(4),
      );
      balanceAfter = flourItem.current_quantity;
    }
    const stored = { ...row, id: `mv-${++seq}`, balance_after: balanceAfter };
    movements.push(stored);
    return { data: stored, error: null };
  }

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let op: "select" | "insert" | "update" = "select";
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
      order: () => api,
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return api;
      },
      update: (patch: any) => {
        op = "update";
        payload = patch;
        return api;
      },
      single: () => resolve("single"),
      maybeSingle: () => resolve("maybeSingle"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      const single = mode !== "list";
      if (table === "restaurant_recipes" && op === "select") {
        return { data: recipe, error: null };
      }
      if (table === "restaurant_recipe_lines" && op === "select") {
        return { data: recipeLines, error: null };
      }
      if (table === "restaurant_inventory_items" && op === "select") {
        if (inFilters.id) {
          return {
            data: [flourItem].filter((i) => inFilters.id!.includes(i.id)),
            error: null,
          };
        }
        return { data: flourItem, error: null };
      }
      if (table === "restaurant_inventory_units" && op === "select") {
        return { data: units.filter((u) => inFilters.id?.includes(u.id)), error: null };
      }
      if (table === "restaurant_members") {
        return {
          data: [{ tenant_id: TENANT, user_id: USER, role: "inventory_manager" }],
          error: null,
        };
      }
      if (table === "restaurant_productions" && op === "insert") {
        seq += 1;
        const id = `production-${seq}`;
        productions[id] = { id, ...payload };
        return { data: productions[id], error: null };
      }
      if (table === "restaurant_productions" && op === "select") {
        const id = filters.id as string;
        return { data: productions[id] ?? null, error: null };
      }
      if (table === "restaurant_productions" && op === "update") {
        const id = filters.id as string;
        productions[id] = { ...productions[id], ...payload };
        return { data: productions[id], error: null };
      }
      if (table === "restaurant_production_inputs" && op === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const r of rows) {
          seq += 1;
          const id = `input-${seq}`;
          productionInputs[id] = { id, ...r };
        }
        return { data: null, error: null };
      }
      if (table === "restaurant_production_inputs" && op === "select") {
        const productionId = filters.production_id as string;
        return {
          data: Object.values(productionInputs).filter(
            (i: any) => i.production_id === productionId,
          ),
          error: null,
        };
      }
      if (table === "restaurant_production_inputs" && op === "update") {
        const id = filters.id as string;
        productionInputs[id] = { ...productionInputs[id], ...payload };
        return { data: null, error: null };
      }
      if (table === "restaurant_stock_movements" && op === "insert") {
        return applyMovement({
          tenant_id: payload.tenant_id,
          location_id: payload.location_id,
          inventory_item_id: payload.inventory_item_id,
          movement_type: payload.movement_type,
          quantity: payload.quantity,
          unit_cost: payload.unit_cost,
          total_cost: payload.total_cost,
          dedupe_key: payload.dedupe_key,
        });
      }
      return { data: single ? null : [], error: null };
    }

    return api;
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string) => {
        if (fn === "has_any_role") return { data: false, error: null };
        return { data: null, error: null };
      },
    },
    flourItem,
    productions,
    productionInputs,
    movements,
  };
}

describe("startProduction / completeProduction — production input unit conversion", () => {
  it("converts a gram recipe line against a KG-stocked item before planning or consuming stock", async () => {
    const fake = makeFakeSupabase();
    const production = await startProduction(fake.supabase as any, USER, {
      tenantId: TENANT,
      recipeId: RECIPE,
      batches: 1,
    });

    const input = Object.values(fake.productionInputs)[0] as any;
    expect(input).toBeTruthy();
    // 500 GRAMS converted to the item's KG stock unit = 0.5, never 500.
    expect(input.planned_quantity).toBe(0.5);
    expect(input.actual_quantity).toBe(0.5);
    expect(input.unit_id).toBe(KG_UNIT);
    // Costed per kilogram (5000/kg): 0.5kg * 5000 = 2500, never 500*5000.
    expect(input.total_cost).toBe(2500);

    await completeProduction(fake.supabase as any, USER, {
      tenantId: TENANT,
      productionId: production.id,
      actualQuantity: 1,
      inputs: [],
    });

    const consumption = fake.movements.find((m) => m.movement_type === "consumption");
    expect(consumption).toBeTruthy();
    expect(Number(consumption!.quantity)).toBe(-0.5); // not -500
    expect(fake.flourItem.current_quantity).toBe(99.5); // 100 - 0.5, not 100 - 500
  });

  it("scales correctly for multiple batches (3 batches x 500g = 1.5kg, not 1500)", async () => {
    const fake = makeFakeSupabase();
    await startProduction(fake.supabase as any, USER, {
      tenantId: TENANT,
      recipeId: RECIPE,
      batches: 3,
    });
    const input = Object.values(fake.productionInputs)[0] as any;
    expect(input.planned_quantity).toBe(1.5);
  });

  it("refuses to start production when a component's unit cannot be resolved to the item's stock unit", async () => {
    // The recipe line is written in a unit ("piece", dimension "count") with
    // no dimensional relationship to the item's stock unit ("kilogram",
    // dimension "mass") and no declared content bridge on the item — an
    // unresolvable conversion, not merely a missing one.
    const badFake = makeFakeSupabase({ lineUnitId: COUNT_UNIT.id, extraUnits: [COUNT_UNIT] });

    await expect(
      startProduction(badFake.supabase as any, USER, {
        tenantId: TENANT,
        recipeId: RECIPE,
        batches: 1,
      }),
    ).rejects.toThrow(/cannot be costed or consumed/);
    expect(Object.keys(badFake.productions)).toHaveLength(0);
    expect(Object.keys(badFake.productionInputs)).toHaveLength(0);
  });
});
