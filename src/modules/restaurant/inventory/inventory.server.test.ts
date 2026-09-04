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

function makeFakeSupabase(opts: { existingBarcode?: string } = {}) {
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
          if (opts.existingBarcode && payload.barcode === opts.existingBarcode) {
            return {
              data: null,
              error: {
                message:
                  'duplicate key value violates unique constraint "idx_restaurant_inv_items_barcode"',
              },
            };
          }
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
      rpc: async (fn: string) => {
        if (fn === "has_any_role") return { data: false, error: null };
        if (fn === "restaurant_next_document_number")
          return { data: "ITM-2026-00001", error: null };
        return { data: null, error: null };
      },
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
      packSize: 1,
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
      packSize: 1,
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
      packSize: 1,
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
      packSize: 1,
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
      packSize: 1,
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

describe("upsertInventoryItem — SKU generation and barcode identity", () => {
  it("auto-generates a deterministic SKU via the shared document sequence when none is supplied", async () => {
    const fake = makeFakeSupabase();
    const result = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      name: "Olive oil",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 0,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 1,
    } as any);
    expect(fake.items[result.id].sku).toBe("ITM-2026-00001");
  });

  it("never overwrites a caller-supplied SKU with a generated one", async () => {
    const fake = makeFakeSupabase();
    const result = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      name: "Olive oil",
      sku: "SUPPLIER-CODE-42",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 0,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 1,
    } as any);
    expect(fake.items[result.id].sku).toBe("SUPPLIER-CODE-42");
  });

  it("never generates a SKU when editing an existing item that already has one", async () => {
    const fake = makeFakeSupabase();
    const created = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      name: "Olive oil",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 0,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 1,
    } as any);
    const originalSku = fake.items[created.id].sku;

    await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      id: created.id,
      name: "Olive oil (extra virgin)",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 0,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 1,
    } as any);
    expect(fake.items[created.id].sku).toBe(originalSku); // untouched by the edit
  });

  it("persists a barcode distinct from sku and internal id", async () => {
    const fake = makeFakeSupabase();
    const result = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      name: "Coca-Cola 500ml",
      barcode: "5449000000996",
      itemType: "beverage",
      currentQuantity: 0,
      averageCost: 0,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 1,
    } as any);
    expect(fake.items[result.id].barcode).toBe("5449000000996");
    expect(fake.items[result.id].barcode).not.toBe(fake.items[result.id].sku);
    expect(fake.items[result.id].barcode).not.toBe(result.id);
  });

  it("reports a duplicate barcode as an operator-facing error, not a raw constraint violation", async () => {
    const fake = makeFakeSupabase({ existingBarcode: "5449000000996" });
    await expect(
      upsertInventoryItem(fake.supabase, USER, {
        tenantId: TENANT,
        name: "Coca-Cola 500ml (duplicate scan)",
        barcode: "5449000000996",
        itemType: "beverage",
        currentQuantity: 0,
        averageCost: 0,
        currency: "TZS",
        trackBatches: false,
        allowNegative: false,
        packSize: 1,
      } as any),
    ).rejects.toThrow(/barcode.*already on file/i);
  });
});

describe("upsertInventoryItem — pack size is real conversion configuration, never a silent default", () => {
  // restaurant_inventory_items.pack_size is NOT NULL DEFAULT 1. A prior bug
  // wrote `pack_size: input.packSize ?? null` — undefined became an explicit
  // null, which overrides the column default and trips the constraint.
  // packSize is now required by the schema; this proves the value the
  // caller supplied is the value that lands on the row, not 1 by accident.
  it("persists a caller-supplied pack size distinct from the column default", async () => {
    const fake = makeFakeSupabase();
    const result = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      name: "Eggs (30-pack)",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 0,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 30,
    } as any);
    expect(fake.items[result.id].pack_size).toBe(30);
  });

  it("never nulls pack_size when a caller omits it from the payload object entirely", async () => {
    // Regression for the exact defect: even if a caller constructs the
    // input without the key at all (not even `packSize: undefined`), the
    // row written must carry a real number, never null.
    const fake = makeFakeSupabase();
    const input: Record<string, unknown> = {
      tenantId: TENANT,
      name: "Regression item",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 0,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 1,
    };
    delete input.packSize;
    await expect(upsertInventoryItem(fake.supabase, USER, input as any)).rejects.toThrow();
  });

  it("keeps the item's existing pack size untouched when editing unrelated metadata", async () => {
    const fake = makeFakeSupabase();
    const created = await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      name: "Cooking oil",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 0,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 5,
    } as any);
    expect(fake.items[created.id].pack_size).toBe(5);

    await upsertInventoryItem(fake.supabase, USER, {
      tenantId: TENANT,
      id: created.id,
      name: "Cooking oil (sunflower)",
      itemType: "ingredient",
      currentQuantity: 0,
      averageCost: 0,
      currency: "TZS",
      trackBatches: false,
      allowNegative: false,
      packSize: 5,
    } as any);
    expect(fake.items[created.id].pack_size).toBe(5);
    expect(fake.items[created.id].name).toBe("Cooking oil (sunflower)");
  });
});
