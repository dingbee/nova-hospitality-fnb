/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * ME-05 inventory integrity certification — `issueRequisition`.
 *
 * Before this pass: the transfer_out/transfer_in pair this function posts had
 * no compensation on a failed inbound leg (unlike `transferStock`, which was
 * already fixed), so a failure between the two legs left stock permanently
 * removed from the source with nothing received at the destination. Worse,
 * because the dedupe key is derived from `line.issued_quantity` (which is
 * only ever advanced after BOTH legs succeed), a naive retry recomputed the
 * exact same dedupe key, hit the stranded outbound leg's row, and silently
 * skipped the whole line forever (`if (!out) continue;`) — the requisition
 * line could never actually be completed or reported as failed.
 */
import { describe, expect, it } from "vitest";
import { issueRequisition } from "./requisitions.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const REQUISITION = "33333333-3333-3333-3333-333333333333";
const LINE = "44444444-4444-4444-4444-444444444444";
const ITEM = "55555555-5555-5555-5555-555555555555";
const SOURCE = "66666666-6666-6666-6666-666666666666";
const DEST = "77777777-7777-7777-7777-777777777777";

function makeFakeSupabase(opts: { itemQuantity: number; failInboundOnce?: boolean }) {
  const requisition = {
    id: REQUISITION,
    tenant_id: TENANT,
    reference: "REQ-TEST-1",
    status: "approved",
    property_id: null,
    source_location_id: SOURCE,
    destination_location_id: DEST,
    correlation_id: null,
  };
  const line = {
    id: LINE,
    tenant_id: TENANT,
    requisition_id: REQUISITION,
    inventory_item_id: ITEM,
    unit_id: "unit-1",
    requested_quantity: 20,
    approved_quantity: 20,
    issued_quantity: 0,
  };
  const item = {
    id: ITEM,
    name: "Requisition test ingredient",
    average_cost: 200,
    currency: "TZS",
    unit_id: "unit-1",
    location_id: SOURCE,
    property_id: null,
    current_quantity: opts.itemQuantity,
  };
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
      if (table === "restaurant_requisitions" && op === "select") {
        return { data: requisition, error: null };
      }
      if (table === "restaurant_requisitions" && op === "update") {
        Object.assign(requisition, payload);
        return { data: requisition, error: null };
      }
      if (table === "restaurant_requisition_lines" && op === "select") {
        return { data: mode === "list" ? [line] : line, error: null };
      }
      if (table === "restaurant_requisition_lines" && op === "update") {
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
          throw new Error(result.error.message);
        }
        return result;
      }
      if (table === "restaurant_stock_movements" && op === "select") {
        if (filters.dedupe_key) {
          return {
            data: movements.find((m) => m.dedupe_key === filters.dedupe_key) ?? null,
            error: null,
          };
        }
        if (filters.reversal_of_id) {
          return {
            data: movements.find((m) => m.reversal_of_id === filters.reversal_of_id) ?? null,
            error: null,
          };
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
    line,
    movements,
  };
}

describe("issueRequisition — atomicity and retry safety of the transfer_out/transfer_in pair", () => {
  it("issues the full line in one call: source -20, destination +20, issued_quantity advances", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 50 });
    await issueRequisition(fake.supabase as any, USER, {
      tenantId: TENANT,
      requisitionId: REQUISITION,
      lines: [{ lineId: LINE, issueQuantity: 20 }],
    });
    expect(fake.movements).toHaveLength(2);
    expect(fake.item.current_quantity).toBe(50); // net unchanged network-wide
    expect(fake.line.issued_quantity).toBe(20);
  });

  it("compensates the outbound leg when the inbound leg fails, instead of leaving stock stuck in transit", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 50, failInboundOnce: true });
    await expect(
      issueRequisition(fake.supabase as any, USER, {
        tenantId: TENANT,
        requisitionId: REQUISITION,
        lines: [{ lineId: LINE, issueQuantity: 20 }],
      }),
    ).rejects.toThrow("connection lost");

    expect(fake.movements).toHaveLength(2); // outbound + compensating reversal
    expect(fake.movements[1]!.movement_type).toBe("reversal");
    expect(fake.item.current_quantity).toBe(50); // fully restored
    expect(fake.line.issued_quantity).toBe(0); // never advanced — nothing was actually issued
  });

  it("refuses to silently skip a line whose outbound leg was already compensated, instead of stranding it forever", async () => {
    const fake = makeFakeSupabase({ itemQuantity: 50, failInboundOnce: true });
    const input = {
      tenantId: TENANT,
      requisitionId: REQUISITION,
      lines: [{ lineId: LINE, issueQuantity: 20 }],
    };
    await expect(issueRequisition(fake.supabase as any, USER, input)).rejects.toThrow(
      "connection lost",
    );
    expect(fake.movements).toHaveLength(2);

    // Retrying with the exact same (line, quantity, pre-issue baseline) —
    // which is what a naive automatic retry would do, since issued_quantity
    // never advanced — must fail loudly, not silently no-op and leave the
    // line permanently stuck.
    await expect(issueRequisition(fake.supabase as any, USER, input)).rejects.toThrow(
      "failed and was rolled back",
    );
    expect(fake.movements).toHaveLength(2); // no lone inbound leg created
    expect(fake.movements.some((m) => m.movement_type === "transfer_in")).toBe(false);
    expect(fake.item.current_quantity).toBe(50);
    expect(fake.line.issued_quantity).toBe(0);
  });
});
