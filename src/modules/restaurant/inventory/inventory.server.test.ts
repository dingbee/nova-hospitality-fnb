/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * Ops UAT gap #6/#12 — new inventory items must post through the ledger.
 *
 * upsertInventoryItem used to stamp `current_quantity` directly onto the
 * row, bypassing restaurant_stock_movements entirely. That is exactly the
 * "second stock-balance system" the movement ledger exists to prevent: the
 * item's aggregate quantity and restaurant_stock_positions_v (the
 * per-location read model every transfer/consumption screen relies on)
 * silently diverge from day one, and restaurant_stock_reconciliation_v's
 * drift column would flag every new item with opening stock. Fixed by
 * posting a real opening_balance movement instead.
 */
import { describe, expect, it } from "vitest";
import { upsertInventoryItem } from "./inventory.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const LOCATION = "33333333-3333-3333-3333-333333333333";

function makeFakeSupabase() {
  const items: Record<string, any> = {};
  const movements: any[] = [];
  let seq = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let op: "select" | "update" | "insert" = "select";
    let payload: any;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      update: (patch: any) => {
        op = "update";
        payload = patch;
        return api;
      },
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return api;
      },
      single: () => resolve(),
      maybeSingle: () => resolve(),
      then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
    };

    async function resolve() {
      if (table === "restaurant_members")
        return {
          data: [{ tenant_id: TENANT, user_id: USER, role: "inventory_manager" }],
          error: null,
        };

      if (table === "restaurant_inventory_items") {
        if (op === "insert") {
          seq += 1;
          const id = `item-${seq}`;
          items[id] = { id, ...payload };
          return { data: items[id], error: null };
        }
        if (op === "update") {
          const id = filters.id as string;
          items[id] = { ...items[id], ...payload };
          return { data: items[id], error: null };
        }
        const id = filters.id as string;
        return { data: items[id] ?? null, error: null };
      }

      if (table === "restaurant_stock_movements" && op === "insert") {
        if (payload.dedupe_key && movements.some((m) => m.dedupe_key === payload.dedupe_key)) {
          return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        const item = items[payload.inventory_item_id];
        const newQty = Number(item.current_quantity ?? 0) + Number(payload.quantity);
        item.current_quantity = newQty;
        const stored = { ...payload, id: `mv-${++seq}`, balance_after: newQty };
        movements.push(stored);
        return { data: stored, error: null };
      }

      return { data: null, error: null };
    }

    return api;
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string) =>
        fn === "has_any_role" ? { data: false, error: null } : { data: null, error: null },
    },
    items,
    movements,
  };
}

describe("upsertInventoryItem — opening balance goes through the ledger", () => {
  it("creates a new item at zero and posts an opening_balance movement for the starting quantity", async () => {
    const fake = makeFakeSupabase();

    const result = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      locationId: LOCATION,
      name: "Tomato",
      itemType: "ingredient",
      currentQuantity: 25,
      averageCost: 800,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
    } as any);

    expect(result.current_quantity).toBe(25);
    expect(fake.movements).toHaveLength(1);
    expect(fake.movements[0]).toMatchObject({
      movement_type: "opening_balance",
      quantity: 25,
      location_id: LOCATION,
      inventory_item_id: result.id,
    });
    // The row itself was never stamped with the quantity directly.
    expect(fake.items[result.id].current_quantity).toBe(25); // only via the movement's ledger effect
  });

  it("creates an item with zero starting stock without posting a movement", async () => {
    const fake = makeFakeSupabase();
    const result = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      name: "Sugar",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 100,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
    } as any);
    expect(result.current_quantity).toBe(0);
    expect(fake.movements).toHaveLength(0);
  });

  it("never rewrites current_quantity when editing an existing item's metadata", async () => {
    const fake = makeFakeSupabase();
    const created = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      locationId: LOCATION,
      name: "Lime",
      itemType: "ingredient",
      currentQuantity: 40,
      averageCost: 200,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
    } as any);
    expect(fake.items[created.id].current_quantity).toBe(40);

    // Ledger moves it independently (e.g. a sale) before the edit happens.
    fake.items[created.id].current_quantity = 33;

    await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      id: created.id,
      locationId: LOCATION,
      name: "Lime (renamed)",
      itemType: "ingredient",
      currentQuantity: 999, // a stale value the edit form might still be holding
      averageCost: 200,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
    } as any);

    // The edit must never overwrite the ledger-derived balance.
    expect(fake.items[created.id].current_quantity).toBe(33);
    expect(fake.items[created.id].name).toBe("Lime (renamed)");
    expect(fake.movements).toHaveLength(1); // only the original opening_balance
  });

  it("is idempotent — retrying the same create never doubles the opening balance", async () => {
    const fake = makeFakeSupabase();
    // Simulate a retried create landing on an already-created item id by
    // reusing insertMovement's dedupe_key directly against the same item.
    const created = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      locationId: LOCATION,
      name: "Chicken breast",
      itemType: "ingredient",
      currentQuantity: 12,
      averageCost: 5000,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
    } as any);
    expect(fake.items[created.id].current_quantity).toBe(12);

    // A second opening_balance for the same item id must be deduped.
    const { insertMovement } = await import("./movements.server");
    const retry = await insertMovement(fake.supabase, USER, {
      tenantId: TENANT,
      locationId: LOCATION,
      inventoryItemId: created.id,
      movementType: "opening_balance",
      quantity: 12,
      unitCost: 5000,
      currency: "TZS",
      dedupeKey: `opening_balance:${created.id}`,
    });
    expect(retry).toBeNull();
    expect(fake.items[created.id].current_quantity).toBe(12); // unchanged
  });
});
