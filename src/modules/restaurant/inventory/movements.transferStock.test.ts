/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * ME-05 inventory integrity certification — `transferStock` (the direct,
 * same-call transfer in movements.server.ts, distinct from the
 * dispatch/receive document flow in transfers.server.ts already covered by
 * transfers.server.test.ts).
 *
 * Before this pass: two sequential `insertMovement` calls with no shared
 * dedupe key and no compensation on partial failure. A retry doubled the
 * transfer (no idempotency), and a failure between the two legs left stock
 * removed from the source with nothing received at the destination (no
 * atomicity) — exactly the failure modes ME-05 mandate section 14
 * ("stock removed from source but not received at destination ... duplicate
 * transfer") prohibits.
 */
import { describe, expect, it } from "vitest";
import { transferStock } from "./movements.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const ITEM = "33333333-3333-3333-3333-333333333333";
const SOURCE = "44444444-4444-4444-4444-444444444444";
const DEST = "55555555-5555-5555-5555-555555555555";

function makeFakeSupabase(opts: { itemQuantity: number; failInboundOnce?: boolean }) {
  const item = {
    id: ITEM,
    name: "Transfer test ingredient",
    average_cost: 1000,
    currency: "TZS",
    unit_id: "unit-1",
    location_id: SOURCE,
    property_id: null,
    allow_negative: false,
    current_quantity: opts.itemQuantity,
  };
  const locations = [
    { id: SOURCE, name: "Dry store" },
    { id: DEST, name: "Kitchen" },
  ];
  const movements: any[] = [];
  let seq = 0;
  let inboundAttempts = 0;

  function applyMovement(row: any) {
    if (row.dedupe_key && movements.some((m) => m.dedupe_key === row.dedupe_key)) {
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    }
    if (row.movement_type === "transfer_in") inboundAttempts += 1;
    if (opts.failInboundOnce && row.movement_type === "transfer_in" && inboundAttempts === 1) {
      return { data: null, error: { code: "08006", message: "connection lost" } };
    }
    item.current_quantity = Number((item.current_quantity + Number(row.quantity)).toFixed(4));
    const stored = { ...row, id: `mv-${++seq}`, balance_after: item.current_quantity };
    movements.push(stored);
    return { data: stored, error: null };
  }

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
      single: () => resolve("single"),
      maybeSingle: () => resolve("maybeSingle"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      const single = mode !== "list";
      if (table === "restaurant_inventory_items" && op === "select") {
        return { data: mode === "list" ? [item] : item, error: null };
      }
      if (table === "restaurant_locations" && op === "select") {
        if (inFilters.id)
          return { data: locations.filter((l) => inFilters.id!.includes(l.id)), error: null };
        return { data: locations, error: null };
      }
      if (table === "restaurant_members") {
        return {
          data: [{ tenant_id: TENANT, user_id: USER, role: "inventory_manager" }],
          error: null,
        };
      }
      if (table === "restaurant_stock_movements" && op === "insert") {
        const result = applyMovement({
          tenant_id: payload.tenant_id,
          location_id: payload.location_id,
          destination_location_id: payload.destination_location_id,
          inventory_item_id: payload.inventory_item_id,
          movement_type: payload.movement_type,
          quantity: payload.quantity,
          unit_cost: payload.unit_cost,
          total_cost: payload.total_cost,
          dedupe_key: payload.dedupe_key,
          reversal_of_id: payload.reversal_of_id,
          correlation_id: payload.correlation_id,
        });
        if (result.error && result.error.code !== "23505") {
          // Simulates a genuine (non-duplicate) database error surfacing as
          // a thrown Error, exactly like insertMovement's own `throw new
          // Error(error.message)` for any non-23505 error.
          throw new Error(result.error.message);
        }
        return result;
      }
      if (table === "restaurant_stock_movements" && op === "select") {
        // Supports findMovementByDedupeKey / movementHasReversal.
        if (filters.dedupe_key) {
          const row = movements.find((m) => m.dedupe_key === filters.dedupe_key) ?? null;
          return { data: row, error: null };
        }
        if (filters.reversal_of_id) {
          const row = movements.find((m) => m.reversal_of_id === filters.reversal_of_id) ?? null;
          return { data: row, error: null };
        }
        return { data: single ? null : [], error: null };
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
    movements,
  };
}

describe("transferStock — atomicity and idempotency of the direct same-call transfer", () => {
  it("moves stock from source to destination in one call: source -10, destination +10, network total unchanged", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const result = await transferStock(fake.supabase as any, USER, {
      tenantId: TENANT,
      inventoryItemId: ITEM,
      destinationLocationId: DEST,
      quantity: 10,
      dedupeKey: "test-transfer-1",
    });
    expect(result.out).toBeTruthy();
    expect(result.in).toBeTruthy();
    expect(fake.movements).toHaveLength(2);
    expect(fake.item.current_quantity).toBe(20); // net network total unchanged
    const outMv = fake.movements.find((m) => m.movement_type === "transfer_out")!;
    const inMv = fake.movements.find((m) => m.movement_type === "transfer_in")!;
    expect(Number(outMv.quantity)).toBe(-10);
    expect(Number(inMv.quantity)).toBe(10);
    expect(outMv.location_id).toBe(SOURCE);
    expect(inMv.location_id).toBe(DEST);
  });

  it("is idempotent on retry — calling transferStock twice with the same dedupeKey never doubles the transfer", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const input = {
      tenantId: TENANT,
      inventoryItemId: ITEM,
      destinationLocationId: DEST,
      quantity: 10,
      dedupeKey: "test-transfer-retry",
    };
    await transferStock(fake.supabase as any, USER, input);
    const secondAttempt = await transferStock(fake.supabase as any, USER, input);

    // The DB-level dedupe_key unique constraint causes both legs of the
    // second attempt to resolve as already-applied (null), not a second
    // pair of movements.
    expect(secondAttempt.out).toBeNull();
    expect(secondAttempt.in).toBeNull();
    expect(fake.movements).toHaveLength(2);
    expect(fake.item.current_quantity).toBe(20);
  });

  it("compensates the outbound leg when the inbound leg fails, instead of leaving stock stuck in transit", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20, failInboundOnce: true });
    await expect(
      transferStock(fake.supabase as any, USER, {
        tenantId: TENANT,
        inventoryItemId: ITEM,
        destinationLocationId: DEST,
        quantity: 10,
        dedupeKey: "test-transfer-fail",
      }),
    ).rejects.toThrow("connection lost");

    // Exactly two movements: the outbound leg and its compensating reversal.
    // No stock was left removed from the source with nothing received at
    // the destination.
    expect(fake.movements).toHaveLength(2);
    expect(fake.movements[0]!.movement_type).toBe("transfer_out");
    expect(fake.movements[1]!.movement_type).toBe("reversal");
    expect(Number(fake.movements[1]!.reversal_of_id ? 1 : 0)).toBe(1);
    expect(fake.item.current_quantity).toBe(20); // fully restored
  });

  it("refuses to retry a dedupeKey whose outbound leg was already compensated, instead of silently moving stock to the destination alone", async () => {
    // Regression for a defect in the compensation fix itself: naively
    // treating "outbound insert returned null" as "already applied, just
    // finish the inbound leg" is wrong once that outbound leg has been
    // reversed — the outbound dedupe key still exists (so a fresh outbound
    // can never be inserted), but it no longer has any effect. Without the
    // reversal check, a retry after the fix above would let a fresh inbound
    // leg succeed alone, creating stock at the destination with nothing
    // actually leaving the source.
    const fake = makeFakeSupabase({ itemQuantity: 20, failInboundOnce: true });
    const input = {
      tenantId: TENANT,
      inventoryItemId: ITEM,
      destinationLocationId: DEST,
      quantity: 10,
      dedupeKey: "test-transfer-dead-key",
    };
    await expect(transferStock(fake.supabase as any, USER, input)).rejects.toThrow(
      "connection lost",
    );
    expect(fake.movements).toHaveLength(2); // outbound + its compensating reversal
    expect(fake.item.current_quantity).toBe(20); // fully restored

    await expect(transferStock(fake.supabase as any, USER, input)).rejects.toThrow(
      "This transfer previously failed and was rolled back",
    );

    // No new movements from the retry — in particular, no lone inbound leg.
    expect(fake.movements).toHaveLength(2);
    expect(fake.movements.some((m) => m.movement_type === "transfer_in")).toBe(false);
    expect(fake.item.current_quantity).toBe(20);
  });
});
