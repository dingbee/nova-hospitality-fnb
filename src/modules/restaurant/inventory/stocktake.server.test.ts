/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * ME-05 inventory integrity certification — `postStocktake`.
 *
 * Before this pass: postStocktake posted `variance_quantity` (counted minus
 * the balance frozen when the count STARTED, T0) as a ledger *delta*. That is
 * only correct if the balance never moved between T0 and post time (T1). Any
 * sale, receipt, waste, transfer or other movement against the same item
 * during the (often long) counting window is real, already-correct activity
 * — posting the stale T0-relative variance on top of it double-applies that
 * activity into the adjustment, manufacturing a phantom discrepancy exactly
 * equal to whatever moved in between. Fixed by re-diffing the counted
 * quantity against a fresh read of the current balance at post time, so an
 * intervening movement that already explains the "discrepancy" results in no
 * adjustment at all.
 */
import { describe, expect, it } from "vitest";
import { postStocktake } from "./stocktake.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const STOCKTAKE = "33333333-3333-3333-3333-333333333333";
const LINE = "44444444-4444-4444-4444-444444444444";
const ITEM = "55555555-5555-5555-5555-555555555555";
const LOCATION = "66666666-6666-6666-6666-666666666666";

function makeFakeSupabase(opts: {
  currentQuantity: number;
  countedQuantity: number;
  expectedQuantity: number;
}) {
  const head = {
    id: STOCKTAKE,
    tenant_id: TENANT,
    stocktake_number: "STK-TEST-1",
    status: "review",
    property_id: null,
    location_id: LOCATION,
    currency: "TZS",
  };
  const line = {
    id: LINE,
    tenant_id: TENANT,
    stocktake_id: STOCKTAKE,
    inventory_item_id: ITEM,
    location_id: LOCATION,
    unit_id: "unit-1",
    unit_cost: 100,
    expected_quantity: opts.expectedQuantity,
    counted_quantity: opts.countedQuantity,
    variance_quantity: opts.countedQuantity - opts.expectedQuantity, // GENERATED column, frozen at T0
    reason_code: null,
    notes: null,
    posted_movement_id: null,
  };
  const item = { id: ITEM, current_quantity: opts.currentQuantity };
  const movements: any[] = [];
  let seq = 0;

  function applyMovement(row: any) {
    if (row.dedupe_key && movements.some((m) => m.dedupe_key === row.dedupe_key)) {
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    }
    item.current_quantity = Number((item.current_quantity + Number(row.quantity)).toFixed(4));
    const stored = { ...row, id: `mv-${++seq}`, balance_after: item.current_quantity };
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
      if (table === "restaurant_stocktakes" && op === "select") {
        return { data: head, error: null };
      }
      if (table === "restaurant_stocktakes" && op === "update") {
        Object.assign(head, payload);
        return { data: head, error: null };
      }
      if (table === "restaurant_stocktake_lines" && op === "select") {
        return { data: mode === "list" ? [line] : line, error: null };
      }
      if (table === "restaurant_stocktake_lines" && op === "update") {
        Object.assign(line, payload);
        return { data: line, error: null };
      }
      if (table === "restaurant_inventory_items" && op === "select") {
        return { data: mode === "list" ? [item] : item, error: null };
      }
      if (table === "restaurant_members") {
        return {
          data: [{ tenant_id: TENANT, user_id: USER, role: "inventory_manager" }],
          error: null,
        };
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
    item,
    line,
    head,
    movements,
  };
}

describe("postStocktake — re-diffs against the current balance, not the stale count-start snapshot", () => {
  it("posts no adjustment when an intervening sale already explains the count-start-vs-counted difference", async () => {
    // T0 (startStocktake): balance = 100, frozen as expected_quantity.
    // Between T0 and counting, a legitimate sale consumes 10 units — the
    // ledger (current_quantity) now correctly reads 90.
    // The physical count also finds 90 (it matches reality).
    // variance_quantity = 90 - 100 = -10 (T0-relative, frozen, still what the
    // UI shows as "the count differed from expectation by -10").
    // But nothing should be POSTED: the ledger already reads 90, which is
    // exactly what was counted.
    const fake = makeFakeSupabase({
      currentQuantity: 90,
      countedQuantity: 90,
      expectedQuantity: 100,
    });
    const result = await postStocktake(fake.supabase as any, USER, {
      tenantId: TENANT,
      stocktakeId: STOCKTAKE,
      approve: true,
    });
    expect(result.posted).toBe(0);
    expect(fake.movements).toHaveLength(0);
    expect(fake.item.current_quantity).toBe(90); // unchanged — already correct
  });

  it("posts exactly the gap between the current balance and the physical count when they genuinely differ", async () => {
    // Balance is currently 90 (nothing moved since counting), counted 85 —
    // a real 5-unit shortage.
    const fake = makeFakeSupabase({
      currentQuantity: 90,
      countedQuantity: 85,
      expectedQuantity: 90,
    });
    const result = await postStocktake(fake.supabase as any, USER, {
      tenantId: TENANT,
      stocktakeId: STOCKTAKE,
      approve: true,
    });
    expect(result.posted).toBe(1);
    expect(fake.movements).toHaveLength(1);
    expect(Number(fake.movements[0]!.quantity)).toBe(-5);
    expect(fake.item.current_quantity).toBe(85);
  });

  it("is idempotent on retry — posting twice never double-applies the adjustment", async () => {
    const fake = makeFakeSupabase({
      currentQuantity: 90,
      countedQuantity: 85,
      expectedQuantity: 90,
    });
    await postStocktake(fake.supabase as any, USER, {
      tenantId: TENANT,
      stocktakeId: STOCKTAKE,
      approve: true,
    });
    // Simulate a retry before the status flip is visible to this caller by
    // resetting only the status guard, not the ledger — the dedupe key is
    // what must prevent double-application.
    fake.head.status = "review";
    const second = await postStocktake(fake.supabase as any, USER, {
      tenantId: TENANT,
      stocktakeId: STOCKTAKE,
      approve: true,
    });
    expect(second.posted).toBe(0);
    expect(fake.movements).toHaveLength(1);
    expect(fake.item.current_quantity).toBe(85);
  });
});
