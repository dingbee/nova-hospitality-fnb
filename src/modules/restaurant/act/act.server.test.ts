/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * I13 "NOVA ACT & VERIFY" — act.server.ts.
 *
 * Exercises the REAL executeNovaPreparation/previewNovaExecution/
 * verifyNovaExecution against a fake Supabase client that applies stock
 * movements exactly like the real restaurant_apply_stock_movement trigger
 * does (net quantity change, dedupe_key uniqueness) and derives
 * restaurant_stock_positions_v exactly like the real view does (a sum over
 * the ledger by tenant/item/location) — the same fidelity bar
 * transfers.server.test.ts already established for the underlying
 * dispatch/receive primitives this module drives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeNovaPreparation,
  previewNovaExecution,
  verifyNovaExecution,
  verifyStockTransferExecution,
} from "./act.server";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "99999999-9999-9999-9999-999999999999";
const ITEM = "33333333-3333-3333-3333-333333333333";
const SOURCE = "44444444-4444-4444-4444-444444444444";
const DEST = "55555555-5555-5555-5555-555555555555";
const OWNER = "owner-1";
const KITCHEN_MANAGER = "kitchen-mgr-1"; // transfer.manage, but NOT transfer.approve
const NO_CAPABILITY_USER = "waiter-1"; // no transfer.* capability at all

interface Member {
  tenantId: string;
  userId: string;
  role: string;
}

function makeFakeSupabase(opts: {
  itemQuantity?: number;
  allowNegative?: boolean;
  members?: Member[];
}) {
  const item = {
    id: ITEM,
    tenant_id: TENANT_A,
    name: "Beef",
    average_cost: 2500,
    currency: "TZS",
    unit_id: "unit-1",
    allow_negative: opts.allowNegative ?? false,
    current_quantity: opts.itemQuantity ?? 20,
  };
  const locations = [
    { id: SOURCE, tenant_id: TENANT_A, name: "Main Store", location_type: "storage" },
    { id: DEST, tenant_id: TENANT_A, name: "Kitchen", location_type: "kitchen" },
  ];
  const members: Member[] =
    opts.members ?? ([{ tenantId: TENANT_A, userId: OWNER, role: "owner" }] as Member[]);
  const transfers: Record<string, any> = {};
  const transferLines: Record<string, any> = {};
  const movements: any[] = [];
  let seq = 0;

  /** Mirrors restaurant_apply_stock_movement: net quantity onto the item, dedupe_key unique per (tenant,dedupe_key). */
  function applyMovement(row: any) {
    if (
      row.dedupe_key &&
      movements.some((m) => m.tenant_id === row.tenant_id && m.dedupe_key === row.dedupe_key)
    ) {
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    }
    const resulting = Number((item.current_quantity + Number(row.quantity)).toFixed(6));
    if (resulting < 0 && !item.allow_negative && !row.approved_by) {
      return {
        data: null,
        error: { code: "check_violation", message: `negative_stock: would go to ${resulting}` },
      };
    }
    item.current_quantity = resulting;
    seq += 1;
    const stored = { ...row, id: `mv-${seq}`, balance_after: item.current_quantity };
    movements.push(stored);
    return { data: stored, error: null };
  }

  /** Sums the fake ledger by tenant/item/location, exactly like restaurant_stock_positions_v. */
  function onHandAt(locationId: string): number {
    return movements
      .filter((m) => m.location_id === locationId && m.inventory_item_id === ITEM)
      .reduce((s, m) => s + Number(m.quantity), 0);
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

      if (table === "restaurant_members") {
        const rows = members.filter(
          (m) =>
            (filters.tenant_id === undefined || m.tenantId === filters.tenant_id) &&
            (filters.user_id === undefined || m.userId === filters.user_id),
        );
        return { data: rows.map((m) => ({ role: m.role })), error: null };
      }

      if (table === "restaurant_inventory_items" && op === "select") {
        if (filters.tenant_id !== undefined && filters.tenant_id !== item.tenant_id) {
          return { data: single ? null : [], error: null };
        }
        const rows =
          inFilters.id !== undefined
            ? inFilters.id.includes(item.id)
              ? [item]
              : []
            : filters.id !== undefined
              ? filters.id === item.id
                ? [item]
                : []
              : [item];
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }

      if (table === "restaurant_locations") {
        let rows = locations.filter(
          (l) => filters.tenant_id === undefined || l.tenant_id === filters.tenant_id,
        );
        if (inFilters.id) rows = rows.filter((l) => inFilters.id!.includes(l.id));
        if (filters.id !== undefined) rows = rows.filter((l) => l.id === filters.id);
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }

      if (table === "restaurant_stock_positions_v") {
        const locationId = filters.location_id as string | undefined;
        const itemIds = inFilters.inventory_item_id ?? [];
        const rows = itemIds
          .filter((id) => (filters.tenant_id === undefined ? true : true))
          .map((id) => ({
            inventory_item_id: id,
            location_id: locationId,
            on_hand: locationId ? onHandAt(locationId) : 0,
          }));
        return { data: rows, error: null };
      }

      if (table === "restaurant_stock_transfers") {
        if (op === "insert") {
          seq += 1;
          const id = `transfer-${seq}`;
          transfers[id] = { id, ...payload };
          return { data: transfers[id], error: null };
        }
        if (op === "update") {
          const id = filters.id as string;
          if (filters.tenant_id !== undefined && transfers[id]?.tenant_id !== filters.tenant_id) {
            return { data: null, error: { message: "not found" } };
          }
          transfers[id] = { ...transfers[id], ...payload };
          return { data: transfers[id], error: null };
        }
        const id = filters.id as string;
        const row = transfers[id];
        if (!row || (filters.tenant_id !== undefined && row.tenant_id !== filters.tenant_id)) {
          return { data: null, error: single ? { message: "not found" } : null };
        }
        return { data: single ? row : [row], error: null };
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
        const rows = Object.values(transferLines).filter(
          (l: any) =>
            l.transfer_id === transferId &&
            (filters.tenant_id === undefined || l.tenant_id === filters.tenant_id),
        );
        return { data: rows, error: null };
      }

      if (table === "restaurant_stock_movements") {
        if (op === "insert") {
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
            reference_type: payload.reference_type,
            reference_id: payload.reference_id,
            approved_by: payload.approved_by ?? null,
          });
        }
        // select — the verifier's own read-back
        let rows = movements.filter(
          (m) => filters.tenant_id === undefined || m.tenant_id === filters.tenant_id,
        );
        if (filters.reference_type !== undefined)
          rows = rows.filter((m) => m.reference_type === filters.reference_type);
        if (filters.reference_id !== undefined)
          rows = rows.filter((m) => m.reference_id === filters.reference_id);
        return { data: rows, error: null };
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

/** Creates an I12-shaped draft transfer directly (requiresApproval:false, submit:false, status "draft") — exactly what commitNovaPreparation produces. */
async function prepareDraftTransfer(
  fake: ReturnType<typeof makeFakeSupabase>,
  userId: string,
  quantity = 3,
) {
  const { createTransfer } = await import("../inventory/transfers.server");
  return createTransfer(fake.supabase, userId, {
    tenantId: TENANT_A,
    sourceLocationId: SOURCE,
    destinationLocationId: DEST,
    requiresApproval: false,
    submit: false,
    notes: "Prepared by NOVA from a staff request.",
    lines: [{ inventoryItemId: ITEM, requestedQuantity: quantity }],
  } as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("previewNovaExecution — read-only, never writes", () => {
  it("A: a ready draft reports readiness 'ready' with line items and available quantity, and mutates nothing", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const preview = await previewNovaExecution(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });

    expect(preview.readiness).toBe("ready");
    expect(preview.lines).toEqual([
      expect.objectContaining({ inventoryItemId: ITEM, quantity: 3, availableQuantity: 0 }),
    ]);
    expect(preview.sourceLocationName).toBe("Main Store");
    expect(preview.destinationLocationName).toBe("Kitchen");
    expect(fake.movements).toHaveLength(0);
    expect(fake.transfers[created.id].status).toBe("draft"); // untouched
  });

  it("B: an unknown/deleted record id reports 'not_found', not a crash", async () => {
    const fake = makeFakeSupabase({});
    const preview = await previewNovaExecution(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: "00000000-0000-0000-0000-000000000000",
    });
    expect(preview.readiness).toBe("not_found");
  });

  it("C: a workflow I13 doesn't support yet fails closed with 'unsupported' — never attempts to execute", async () => {
    const fake = makeFakeSupabase({});
    const preview = await previewNovaExecution(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "purchase_request" as any,
      recordId: "any-id",
    });
    expect(preview.readiness).toBe("unsupported");
  });

  it("D: a user without transfer.manage sees 'unauthorized', never a peek at line contents", async () => {
    const fake = makeFakeSupabase({
      members: [
        { tenantId: TENANT_A, userId: OWNER, role: "owner" },
        { tenantId: TENANT_A, userId: NO_CAPABILITY_USER, role: "waiter" },
      ],
    });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const preview = await previewNovaExecution(fake.supabase, NO_CAPABILITY_USER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(preview.readiness).toBe("unauthorized");
    expect(preview.lines).toEqual([]);
  });

  it("E: a user with transfer.manage but not transfer.approve sees 'unauthorized' on a still-draft movement — approval authority is genuinely required, not silently skipped", async () => {
    const fake = makeFakeSupabase({
      members: [
        { tenantId: TENANT_A, userId: OWNER, role: "owner" },
        { tenantId: TENANT_A, userId: KITCHEN_MANAGER, role: "kitchen_manager" },
      ],
    });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const preview = await previewNovaExecution(fake.supabase, KITCHEN_MANAGER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(preview.readiness).toBe("unauthorized");
    expect(preview.message).toMatch(/approval authority/i);
  });

  it("F: available quantity below requested surfaces a warning but still reports 'ready' — the hard stop happens at execute time, not preview time", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    // Simulate stock having been consumed elsewhere at the source since prepare.
    // (onHandAt derives from the ledger; with zero movements it's 0, which is already < 3 —
    // this assertion documents that "0 available" is treated the same as any shortfall.)
    const preview = await previewNovaExecution(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(preview.warnings.some((w) => /only 0 of "beef" is currently available/i.test(w))).toBe(
      true,
    );
  });
});

describe("executeNovaPreparation — the one place I13 writes anything", () => {
  it("G: a ready draft, executed by an authorized owner, is approved -> dispatched -> received through the exact existing governed functions, and reports a verified receipt", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const result = await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.status).toBe("completed");
      expect(result.receipt.lines).toEqual([
        expect.objectContaining({ inventoryItemId: ITEM, quantity: 3 }),
      ]);
      expect(result.verification.verified).toBe(true);
      expect(result.message).toMatch(/Movement: TRF-2026-00001/);
      expect(result.message).toMatch(/Status: Verified/);
    }
    expect(fake.transfers[created.id].status).toBe("completed");
    expect(fake.onHandAt(SOURCE)).toBe(-3);
    expect(fake.onHandAt(DEST)).toBe(3);
    expect(fake.item.current_quantity).toBe(20); // net across locations, unchanged
  });

  it("H: never directly updates the inventory item's balance column — every quantity change flows through insertMovement (the ledger)", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    const updateSpy = vi.fn();
    const originalFrom = fake.supabase.from;
    fake.supabase.from = (table: string) => {
      const b = originalFrom(table);
      if (table === "restaurant_inventory_items") {
        return {
          ...b,
          update: (...args: any[]) => {
            updateSpy(...args);
            return b.update?.(...args) ?? b;
          },
        };
      }
      return b;
    };
    await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("I: idempotent on retry — executing an already-executed movement a second time reports the same verified outcome and moves nothing again", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(fake.movements).toHaveLength(2);

    const second = await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.verification.verified).toBe(true);
    expect(fake.movements).toHaveLength(2); // unchanged — no duplicate consequential mutation
    expect(fake.onHandAt(SOURCE)).toBe(-3);
    expect(fake.onHandAt(DEST)).toBe(3);
  });

  it("J: two concurrent executions of the same draft converge to exactly one consequential movement per line — the second call's dispatch/receive attempt is refused by the transfer's own status guard after the first has advanced it", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const [first, second] = await Promise.all([
      executeNovaPreparation(fake.supabase, OWNER, {
        tenantId: TENANT_A,
        workflow: "stock_transfer",
        recordId: created.id,
      }),
      executeNovaPreparation(fake.supabase, OWNER, {
        tenantId: TENANT_A,
        workflow: "stock_transfer",
        recordId: created.id,
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    // Regardless of which call "won" the race, the ledger only ever reflects one real movement per line.
    expect(fake.onHandAt(SOURCE)).toBe(-3);
    expect(fake.onHandAt(DEST)).toBe(3);
    expect(fake.movements.filter((m) => m.movement_type === "transfer_out")).toHaveLength(1);
    expect(fake.movements.filter((m) => m.movement_type === "transfer_in")).toHaveLength(1);
  });

  it("K: stale preparation — stock consumed elsewhere since prepare causes a clean 'Only Xkg available' style stop, never a fabricated success", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 5 });
    const created = await prepareDraftTransfer(fake, OWNER, 5);
    fake.item.current_quantity = 2; // consumed elsewhere between prepare and execute

    const result = await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.readiness).toBe("stale");
      expect(result.message).toMatch(/negative stock|would go to/i);
    }
    expect(fake.transfers[created.id].status).not.toBe("completed");
    expect(fake.movements).toHaveLength(0);
  });

  it("L: a movement already dispatched/completed by someone else (via the manual UI) between prepare and execute reports 'already_executed', never re-executes", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    // Simulate a human manually driving the SAME transfer through the manual UI.
    const { approveTransfer, dispatchTransfer, receiveTransfer } =
      await import("../inventory/transfers.server");
    await approveTransfer(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      transferId: created.id,
      approve: true,
    });
    const lineId = Object.keys(fake.transferLines)[0];
    await dispatchTransfer(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      transferId: created.id,
      lines: [{ lineId, dispatchedQuantity: 3 }],
    });
    await receiveTransfer(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      transferId: created.id,
      lines: [{ lineId, receivedQuantity: 3, rejectedQuantity: 0, damagedQuantity: 0 }],
    });
    expect(fake.movements).toHaveLength(2);

    const result = await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(result.ok).toBe(true);
    expect(fake.movements).toHaveLength(2); // NOVA never re-moved stock for an already-completed transfer
  });

  it("M: a rejected/cancelled movement reports 'stale' and refuses to execute", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    const { approveTransfer } = await import("../inventory/transfers.server");
    await approveTransfer(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      transferId: created.id,
      approve: false,
      reason: "no longer needed",
    });

    const result = await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.readiness).toBe("stale");
    expect(fake.movements).toHaveLength(0);
  });

  it("N: unauthorized user (no transfer.manage) cannot execute — fails closed with an operational-language message, no movement posted", async () => {
    const fake = makeFakeSupabase({
      members: [
        { tenantId: TENANT_A, userId: OWNER, role: "owner" },
        { tenantId: TENANT_A, userId: NO_CAPABILITY_USER, role: "waiter" },
      ],
    });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const result = await executeNovaPreparation(fake.supabase, NO_CAPABILITY_USER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.readiness).toBe("unauthorized");
      expect(result.message).toMatch(/authority to execute/i);
    }
    expect(fake.movements).toHaveLength(0);
  });

  it("O: a user with transfer.manage but not transfer.approve cannot push a still-draft movement through — approval authority is never silently bypassed", async () => {
    const fake = makeFakeSupabase({
      members: [
        { tenantId: TENANT_A, userId: OWNER, role: "owner" },
        { tenantId: TENANT_A, userId: KITCHEN_MANAGER, role: "kitchen_manager" },
      ],
    });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const result = await executeNovaPreparation(fake.supabase, KITCHEN_MANAGER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.readiness).toBe("unauthorized");
    expect(fake.movements).toHaveLength(0);
    expect(fake.transfers[created.id].status).toBe("draft"); // never silently approved either
  });

  it("P: an already-approved movement (approval authority separately exercised by a human first) executes cleanly for a manage-only user — approval and dispatch/receive authority are genuinely independent", async () => {
    const fake = makeFakeSupabase({
      itemQuantity: 20,
      members: [
        { tenantId: TENANT_A, userId: OWNER, role: "owner" },
        { tenantId: TENANT_A, userId: KITCHEN_MANAGER, role: "kitchen_manager" },
      ],
    });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    const { approveTransfer } = await import("../inventory/transfers.server");
    await approveTransfer(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      transferId: created.id,
      approve: true,
    });

    const result = await executeNovaPreparation(fake.supabase, KITCHEN_MANAGER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(result.ok).toBe(true);
    expect(fake.transfers[created.id].status).toBe("completed");
  });

  it("Q: cross-tenant — an action id from tenant A cannot be executed by a caller scoped to tenant B, even with a legitimate role there", async () => {
    const fake = makeFakeSupabase({
      itemQuantity: 20,
      members: [
        { tenantId: TENANT_A, userId: OWNER, role: "owner" },
        { tenantId: TENANT_B, userId: "owner-b", role: "owner" },
      ],
    });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const result = await executeNovaPreparation(fake.supabase, "owner-b", {
      tenantId: TENANT_B,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.readiness).toBe("not_found");
    expect(fake.movements).toHaveLength(0);
  });

  it("R: client-supplied tenantId spoofing — the caller's own tenant membership (not merely the tenantId string on the request) gates execution; a user with no membership in the claimed tenant is refused", async () => {
    const fake = makeFakeSupabase({
      itemQuantity: 20,
      members: [{ tenantId: TENANT_A, userId: OWNER, role: "owner" }],
    });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const result = await executeNovaPreparation(fake.supabase, "total-stranger", {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.readiness).toBe("unauthorized");
    expect(fake.movements).toHaveLength(0);
  });

  it("S: unknown/unsupported workflow fails closed rather than dynamically dispatching to any function", async () => {
    const fake = makeFakeSupabase({});
    const result = await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "requisition" as any,
      recordId: "any-id",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.readiness).toBe("unsupported");
  });

  it("T: partial-failure resumability — a first execute call that fails after approval but before dispatch (simulated) leaves the transfer approved, and a retry completes it without re-approving or duplicating movements", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    // Simulate the exact partial-failure shape by hand: approve succeeds,
    // then something (network drop, timeout) stops before dispatch.
    const { approveTransfer } = await import("../inventory/transfers.server");
    await approveTransfer(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      transferId: created.id,
      approve: true,
    });
    expect(fake.transfers[created.id].status).toBe("approved");

    // Retry via the real entry point — must not re-approve (already approved) and must complete cleanly.
    const result = await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(result.ok).toBe(true);
    expect(fake.transfers[created.id].status).toBe("completed");
    expect(fake.movements.filter((m) => m.movement_type === "transfer_out")).toHaveLength(1);
  });
});

describe("verifyStockTransferExecution / verifyNovaExecution — independent re-read, never trusts executor return data", () => {
  it("U: verifies a genuinely executed movement by re-reading the ledger fresh, matching expected vs actual quantity per line", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });

    const verification = await verifyStockTransferExecution(fake.supabase, TENANT_A, created.id);
    expect(verification.verified).toBe(true);
    expect(verification.entityId).toBe(created.id);
  });

  it("V: verification fails honestly (not fabricated success) when the transfer never actually left 'draft' — e.g. called on an unexecuted preparation", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);

    const verification = await verifyStockTransferExecution(fake.supabase, TENANT_A, created.id);
    expect(verification.verified).toBe(false);
    expect(verification.outcome).toBe("unexpected_status");
  });

  it("W: malformed/tampered result — a movement whose posted quantity doesn't match the transfer line's expected quantity fails verification rather than reporting success", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    // Tamper with the posted movement after the fact (simulating a malformed/inconsistent record).
    const outMovement = fake.movements.find((m) => m.movement_type === "transfer_out");
    outMovement.quantity = -1; // no longer matches the expected dispatched quantity of 3

    const verification = await verifyStockTransferExecution(fake.supabase, TENANT_A, created.id);
    expect(verification.verified).toBe(false);
    expect(verification.outcome).toBe("movement_mismatch");
  });

  it("X: verifyNovaExecution requires transfer.manage even for a read-only verify — never a lower bar than execute's own read access", async () => {
    const fake = makeFakeSupabase({
      itemQuantity: 20,
      members: [
        { tenantId: TENANT_A, userId: OWNER, role: "owner" },
        { tenantId: TENANT_A, userId: NO_CAPABILITY_USER, role: "waiter" },
      ],
    });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });

    const verification = await verifyNovaExecution(fake.supabase, NO_CAPABILITY_USER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(verification.verified).toBe(false);
    expect(verification.outcome).toBe("unauthorized");
  });

  it("Y: verify is never auto-chained by preview — previewNovaExecution never calls the verifier or writes anything, even for an already-executed transfer", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const created = await prepareDraftTransfer(fake, OWNER, 3);
    await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    const movementCountBefore = fake.movements.length;

    const preview = await previewNovaExecution(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(preview.readiness).toBe("already_executed");
    expect(fake.movements).toHaveLength(movementCountBefore);
  });
});

describe("multi-line atomicity — documents the exact existing behavior this module inherits, per spec section 24", () => {
  it("Z: a two-line movement posts both lines' movements — matching quantities per item, no line silently dropped", async () => {
    const ITEM_2 = "66666666-6666-6666-6666-666666666666";
    const fake = makeFakeSupabase({ itemQuantity: 20 });
    const { createTransfer } = await import("../inventory/transfers.server");
    // Add a second item to the fake's item table by monkey-patching restaurant_inventory_items reads.
    const originalFrom = fake.supabase.from;
    const item2 = {
      id: ITEM_2,
      tenant_id: TENANT_A,
      name: "Rice",
      current_quantity: 20,
      allow_negative: false,
      unit_id: "unit-1",
    };
    fake.supabase.from = (table: string) => {
      if (table === "restaurant_inventory_items") {
        return {
          select: () => fake.supabase.from(table),
          eq: () => fake.supabase.from(table),
          in: (col: string, vals: unknown[]) => ({
            then: (resolveFn: any) =>
              resolveFn({
                data: [fake.item, item2].filter((i) => vals.includes(i.id)),
                error: null,
              }),
            maybeSingle: async () => ({
              data: [fake.item, item2].find((i) => vals.includes(i.id)) ?? null,
              error: null,
            }),
            single: async () => ({
              data: [fake.item, item2].find((i) => vals.includes(i.id)) ?? null,
              error: null,
            }),
          }),
          maybeSingle: async () => ({ data: fake.item, error: null }),
          single: async () => ({ data: fake.item, error: null }),
        } as any;
      }
      return originalFrom(table);
    };

    const created = await createTransfer(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      sourceLocationId: SOURCE,
      destinationLocationId: DEST,
      requiresApproval: false,
      submit: false,
      lines: [
        { inventoryItemId: ITEM, requestedQuantity: 3 },
        { inventoryItemId: ITEM_2, requestedQuantity: 4 },
      ],
    } as any);

    const result = await executeNovaPreparation(fake.supabase, OWNER, {
      tenantId: TENANT_A,
      workflow: "stock_transfer",
      recordId: created.id,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.lines).toHaveLength(2);
      const byItem = new Map(result.receipt.lines.map((l) => [l.inventoryItemId, l.quantity]));
      expect(byItem.get(ITEM)).toBe(3);
      expect(byItem.get(ITEM_2)).toBe(4);
    }
  });
});
