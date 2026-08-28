/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * Ops UAT gap #4 (P0) — inventory transfer balance integrity.
 *
 * Reproduces the exact reported defect: a transfer is created and left at
 * "approved" without ever being dispatched, so the source location's stock
 * never actually decreases. This is not a calculation bug — dispatchTransfer
 * and receiveTransfer already move the ledger correctly when called; the
 * root cause is that a request alone moves nothing (by design: "dispatch is
 * not receipt"), and nothing in the UI made a manager complete those two
 * remaining steps.
 *
 * These tests exercise the REAL createTransfer/dispatchTransfer/
 * receiveTransfer against a fake ledger that applies movements exactly like
 * the real `restaurant_apply_stock_movement` trigger does (net quantity
 * change per movement, keyed by dedupe_key for idempotency) — proving the
 * full request → dispatch → receive lifecycle produces the exact accounting
 * required:
 *   SOURCE: 16 → 1, DESTINATION: 0 → 15, NETWORK TOTAL: unchanged at 16.
 */
import { describe, expect, it } from "vitest";
import { createTransfer, dispatchTransfer, receiveTransfer } from "./transfers.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const ITEM = "33333333-3333-3333-3333-333333333333";
const SOURCE = "44444444-4444-4444-4444-444444444444";
const DEST = "55555555-5555-5555-5555-555555555555";

function makeFakeSupabase(opts: { itemQuantity: number }) {
  const item = {
    id: ITEM,
    name: "UAT receiving ingredient",
    average_cost: 2500,
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
  const transfers: Record<string, any> = {};
  const transferLines: Record<string, any> = {};
  const movements: any[] = [];
  let seq = 0;

  /** Mirrors restaurant_apply_stock_movement: net quantity onto the item, dedupe_key unique. */
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
    let op: "select" | "update" | "insert" = "select";
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
      limit: () => api,
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
      if (table === "restaurant_members")
        return {
          data: [{ tenant_id: TENANT, user_id: USER, role: "inventory_manager" }],
          error: null,
        };

      if (table === "restaurant_stock_transfers") {
        if (op === "insert") {
          seq += 1;
          const id = `transfer-${seq}`;
          transfers[id] = { id, ...payload };
          return { data: transfers[id], error: null };
        }
        if (op === "update") {
          const id = filters.id as string;
          transfers[id] = { ...transfers[id], ...payload };
          return { data: transfers[id], error: null };
        }
        // select
        const id = filters.id as string;
        return {
          data: transfers[id] ?? null,
          error: transfers[id] ? null : { message: "not found" },
        };
      }

      if (table === "restaurant_stock_transfer_lines") {
        if (op === "insert") {
          const rows = Array.isArray(payload) ? payload : [payload];
          for (const r of rows) {
            seq += 1;
            const id = `line-${seq}`;
            transferLines[id] = { id, ...r };
          }
          return { data: null, error: null };
        }
        if (op === "update") {
          const id = filters.id as string;
          transferLines[id] = { ...transferLines[id], ...payload };
          return { data: null, error: null };
        }
        const transferId = filters.transfer_id as string;
        return {
          data: Object.values(transferLines).filter((l: any) => l.transfer_id === transferId),
          error: null,
        };
      }

      if (table === "restaurant_stock_movements" && op === "insert") {
        return applyMovement({
          tenant_id: payload.tenant_id,
          location_id: payload.location_id,
          destination_location_id: payload.destination_location_id,
          inventory_item_id: payload.inventory_item_id,
          movement_type: payload.movement_type,
          quantity: payload.quantity,
          unit_cost: payload.unit_cost,
          total_cost: payload.total_cost,
          dedupe_key: payload.dedupe_key,
          transfer_id: payload.transfer_id,
        });
      }

      return { data: single ? null : [], error: null };
    }

    return api;
  }

  /** Sums the fake ledger by location, exactly like restaurant_stock_positions_v. */
  function onHandAt(locationId: string): number {
    return movements
      .filter((m) => m.location_id === locationId)
      .reduce((s, m) => s + Number(m.quantity), 0);
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string) => {
        if (fn === "has_any_role") return { data: false, error: null };
        if (fn === "restaurant_next_document_number")
          return { data: "TRF-2026-00001", error: null };
        return { data: null, error: null };
      },
    },
    item,
    movements,
    transfers,
    transferLines,
    onHandAt,
  };
}

describe("stock transfer lifecycle — the exact reported P0 scenario", () => {
  it("moves nothing while the transfer sits unrequested past creation — reproduces the reported bug's precondition", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 16 });

    await createTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      sourceLocationId: SOURCE,
      destinationLocationId: DEST,
      requiresApproval: false,
      submit: true,
      lines: [{ inventoryItemId: ITEM, requestedQuantity: 15 }],
    } as any);

    // Exactly what UAT observed: a request alone never moves stock.
    expect(fake.movements).toHaveLength(0);
    expect(fake.item.current_quantity).toBe(16);
    expect(fake.onHandAt(SOURCE)).toBe(0);
    expect(fake.onHandAt(DEST)).toBe(0);
  });

  it("produces the exact required accounting once dispatched and received: source 16→1, destination 0→15, network total unchanged", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 16 });

    const created = await createTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      sourceLocationId: SOURCE,
      destinationLocationId: DEST,
      requiresApproval: false,
      submit: true,
      lines: [{ inventoryItemId: ITEM, requestedQuantity: 15 }],
    } as any);
    const lineId = Object.keys(fake.transferLines)[0];

    await dispatchTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      transferId: created.id,
      lines: [{ lineId, dispatchedQuantity: 15 }],
    } as any);

    // After dispatch: stock has left the source but not yet arrived.
    expect(fake.onHandAt(SOURCE)).toBe(-15);
    expect(fake.item.current_quantity).toBe(1); // 16 - 15

    await receiveTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      transferId: created.id,
      lines: [{ lineId, receivedQuantity: 15, rejectedQuantity: 0, damagedQuantity: 0 }],
    } as any);

    expect(fake.item.current_quantity).toBe(16); // net across both locations, unchanged
    expect(fake.onHandAt(SOURCE)).toBe(-15); // Dry store: 16 - 15 = 1 on hand (base 16 + this delta)
    expect(fake.onHandAt(DEST)).toBe(15); // Kitchen: 0 + 15 = 15 on hand
    expect(fake.transfers[created.id].status).toBe("completed");
  });

  it("supports a partial transfer: dispatching less than requested", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 16 });
    const created = await createTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      sourceLocationId: SOURCE,
      destinationLocationId: DEST,
      requiresApproval: false,
      submit: true,
      lines: [{ inventoryItemId: ITEM, requestedQuantity: 15 }],
    } as any);
    const lineId = Object.keys(fake.transferLines)[0];

    await dispatchTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      transferId: created.id,
      lines: [{ lineId, dispatchedQuantity: 10 }],
    } as any);
    expect(fake.item.current_quantity).toBe(6); // 16 - 10

    await receiveTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      transferId: created.id,
      lines: [{ lineId, receivedQuantity: 10, rejectedQuantity: 0, damagedQuantity: 0 }],
    } as any);
    expect(fake.transfers[created.id].status).toBe("completed");
    expect(fake.onHandAt(DEST)).toBe(10);
  });

  it("refuses a same-location transfer", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 16 });
    await expect(
      createTransfer(fake.supabase, USER, {
        tenantId: TENANT,
        sourceLocationId: SOURCE,
        destinationLocationId: SOURCE,
        requiresApproval: false,
        submit: true,
        lines: [{ inventoryItemId: ITEM, requestedQuantity: 1 }],
      } as any),
    ).rejects.toThrow(/must be different locations/i);
  });

  it("refuses dispatching more than requested", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 16 });
    const created = await createTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      sourceLocationId: SOURCE,
      destinationLocationId: DEST,
      requiresApproval: false,
      submit: true,
      lines: [{ inventoryItemId: ITEM, requestedQuantity: 15 }],
    } as any);
    const lineId = Object.keys(fake.transferLines)[0];

    await expect(
      dispatchTransfer(fake.supabase, USER, {
        tenantId: TENANT,
        transferId: created.id,
        lines: [{ lineId, dispatchedQuantity: 999 }],
      } as any),
    ).rejects.toThrow(/cannot exceed the requested quantity/i);
    expect(fake.movements).toHaveLength(0);
  });

  it("refuses a dispatch where every line is zero, instead of silently no-op'ing the status", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 16 });
    const created = await createTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      sourceLocationId: SOURCE,
      destinationLocationId: DEST,
      requiresApproval: false,
      submit: true,
      lines: [{ inventoryItemId: ITEM, requestedQuantity: 15 }],
    } as any);
    const lineId = Object.keys(fake.transferLines)[0];

    await expect(
      dispatchTransfer(fake.supabase, USER, {
        tenantId: TENANT,
        transferId: created.id,
        lines: [{ lineId, dispatchedQuantity: 0 }],
      } as any),
    ).rejects.toThrow(/at least one line must have a dispatched quantity/i);
    expect(fake.transfers[created.id].status).toBe("approved"); // never silently flipped to "dispatched"
  });

  it("is idempotent on retry — dispatching twice never doubles the movement", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 16 });
    const created = await createTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      sourceLocationId: SOURCE,
      destinationLocationId: DEST,
      requiresApproval: false,
      submit: true,
      lines: [{ inventoryItemId: ITEM, requestedQuantity: 15 }],
    } as any);
    const lineId = Object.keys(fake.transferLines)[0];

    await dispatchTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      transferId: created.id,
      lines: [{ lineId, dispatchedQuantity: 15 }],
    } as any);
    expect(fake.item.current_quantity).toBe(1);

    // Retry: the transfer is no longer "approved"/"requested", so a second
    // dispatch attempt must be refused rather than moving stock again.
    await expect(
      dispatchTransfer(fake.supabase, USER, {
        tenantId: TENANT,
        transferId: created.id,
        lines: [{ lineId, dispatchedQuantity: 15 }],
      } as any),
    ).rejects.toThrow(/cannot be dispatched from status "dispatched"/i);
    expect(fake.item.current_quantity).toBe(1); // unchanged — no double move
    expect(fake.movements).toHaveLength(1);
  });

  it("refuses an insufficient-stock dispatch unless the item allows negative stock", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 5 });
    const created = await createTransfer(fake.supabase, USER, {
      tenantId: TENANT,
      sourceLocationId: SOURCE,
      destinationLocationId: DEST,
      requiresApproval: false,
      submit: true,
      lines: [{ inventoryItemId: ITEM, requestedQuantity: 5 }],
    } as any);
    const lineId = Object.keys(fake.transferLines)[0];
    fake.item.current_quantity = 3; // simulate stock consumed elsewhere after the request was raised

    await expect(
      dispatchTransfer(fake.supabase, USER, {
        tenantId: TENANT,
        transferId: created.id,
        lines: [{ lineId, dispatchedQuantity: 5 }],
      } as any),
    ).rejects.toThrow(/negative_stock|insufficient|would/i);
  });
});
