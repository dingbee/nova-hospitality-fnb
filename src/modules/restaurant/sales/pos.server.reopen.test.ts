/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-06: reopenPosOrder must not let a fiscally-finalized bill be reopened.
 *
 * reopenPosOrder only checked restaurant_orders.status !== "closed" before
 * putting a closed bill back into "served" (editable) state. It never
 * consulted restaurant_fiscal_receipts. A bill whose fiscal receipt had
 * already reached "fiscalized" (a real fiscal document reported to the tax
 * authority, per FISCAL_TERMINAL_STATES in ../fiscal/contracts.ts) could be
 * reopened, have its items/totals changed, and re-closed — and because
 * requestFiscalization's own idempotency short-circuits on an existing
 * "fiscalized" receipt (fiscal.server.ts) rather than re-submitting, the
 * order's totals would silently diverge from what was actually reported to
 * TRA, with no reversal/credit-note and no alarm anywhere. This is the
 * money invariant fiscal finalization exists to protect (mandate section 11:
 * "After finalization, test attempts to modify... items... Any mutation
 * that bypasses the intended fiscal-control model must be fixed").
 *
 * Fix: reopenPosOrder now looks up the order's fiscal receipt and refuses
 * the reopen when its state is "fiscalized".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
}));
vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));

const { reopenPosOrder } = await import("./pos.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const ORDER = "33333333-3333-3333-3333-333333333333";

function makeFixture(opts: { fiscalState?: string | null; orderStatus?: string } = {}) {
  const orders = [
    {
      id: ORDER,
      tenant_id: TENANT,
      order_number: "A-100",
      status: opts.orderStatus ?? "closed",
      location_id: "loc-1",
      property_id: "prop-1",
      table_id: null,
    },
  ];
  const fiscalReceipts =
    opts.fiscalState == null
      ? []
      : [{ tenant_id: TENANT, order_id: ORDER, state: opts.fiscalState }];
  const calls: Array<{ op: string; table: string; payload?: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "update" = "select";
    let payload: any;
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      maybeSingle: () => resolve("maybeSingle"),
      single: () => resolve("single"),
      then: (onFulfilled: any, onRejected: any) => resolve("list").then(onFulfilled, onRejected),
    };

    function rowsFor(): any[] {
      if (table === "restaurant_orders") return orders;
      if (table === "restaurant_fiscal_receipts") return fiscalReceipts;
      if (table === "restaurant_tables") return [];
      return [];
    }

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      const matches = (r: any) => filters.every((f) => f(r));
      if (op === "update") {
        calls.push({ op: "update", table, payload });
        const rows = rowsFor().filter(matches);
        for (const r of rows) Object.assign(r, payload);
        return { data: rows[0] ?? null, error: null };
      }
      const rows = rowsFor().filter(matches);
      if (mode === "list") return { data: rows, error: null };
      return {
        data: rows[0] ?? null,
        error: mode === "single" && !rows[0] ? { message: "not found" } : null,
      };
    }
    return api;
  }

  return { supabase: { from }, orders, fiscalReceipts, calls };
}

describe("reopenPosOrder — fiscal finalization guard (ME-06)", () => {
  it("refuses to reopen a bill whose fiscal receipt is already fiscalized", async () => {
    const fixture = makeFixture({ fiscalState: "fiscalized" });
    await expect(
      reopenPosOrder(fixture.supabase, USER, {
        tenantId: TENANT,
        orderId: ORDER,
        reason: "correction",
      } as any),
    ).rejects.toThrow(/already been fiscalized/);

    const orderUpdates = fixture.calls.filter(
      (c) => c.table === "restaurant_orders" && c.op === "update",
    );
    expect(orderUpdates).toHaveLength(0);
    expect(fixture.orders[0].status).toBe("closed");
  });

  it("allows reopening when there is no fiscal receipt at all", async () => {
    const fixture = makeFixture({ fiscalState: null });
    const result = await reopenPosOrder(fixture.supabase, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      reason: "correction",
    } as any);
    expect(result.status).toBe("served");
    expect(fixture.orders[0].status).toBe("served");
  });

  it("allows reopening when the fiscal receipt exists but never reached the fiscalized state (e.g. rejected/not_required)", async () => {
    const fixture = makeFixture({ fiscalState: "not_required" });
    const result = await reopenPosOrder(fixture.supabase, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      reason: "correction",
    } as any);
    expect(result.status).toBe("served");
  });
});
