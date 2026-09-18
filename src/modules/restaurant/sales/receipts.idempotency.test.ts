/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-06 — issueReceipt double-issue race.
 *
 * restaurant_receipts.order_id carries a unique index
 * (restaurant_receipts_order_idx, standalone/db/migrations/0001_fnb_core.sql
 * — confirmed present on production too), so the database itself already
 * guarantees at most one receipt row per order. But issueReceipt's own
 * shape was check-then-insert (SELECT existing, then INSERT only if none
 * was found) with no recovery on the resulting 23505 — the exact
 * check-then-act race ME-03/ME-04 already fixed for
 * takePosPayment/recordGuestPayment/refundPayment, just never applied
 * here. Two near-simultaneous issueReceipt calls for the same order (a
 * double-tap "print receipt", or two staff settling the same table
 * together) would both see no existing receipt, both attempt the INSERT,
 * and the loser would surface a raw Postgres duplicate-key error to the
 * cashier instead of resolving to the same receipt the winner created.
 *
 * Fixed by recovering the winner's row on a 23505 conflict, matching this
 * codebase's established insert-then-recover pattern.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
  assertTenantRead: vi.fn(async () => true),
}));
vi.mock("../events/emit.server", () => ({ emitRestaurantEvent: vi.fn(async () => undefined) }));
vi.mock("../fiscal/fiscal.server", () => ({
  requestFiscalization: vi.fn(async () => ({
    state: "not_required",
    operatorMessage: null,
    fiscalReceiptNumber: null,
    verificationCode: null,
    zNumber: null,
    fiscalizedAt: null,
    environment: null,
  })),
}));

const { issueReceipt } = await import("./receipts.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const ORDER = "33333333-3333-3333-3333-333333333333";

function makeFixture() {
  const orders = [
    {
      id: ORDER,
      tenant_id: TENANT,
      property_id: "prop-1",
      location_id: "loc-1",
      order_number: "A-100",
      subtotal: 100,
      discount_total: 0,
      tax_total: 18,
      service_charge: 0,
      total: 118,
      paid_total: 118,
      cost_total: 40,
      currency: "TZS",
    },
  ];
  const orderItems: any[] = [];
  const payments: any[] = [];
  const receipts: any[] = [];
  let seq = 0;
  // When true, the NEXT "does a receipt already exist for this order?"
  // read returns empty regardless of actual content — simulating a
  // concurrent caller's SELECT running before the real winner's row
  // becomes visible, while the INSERT immediately afterward still hits
  // the real, already-committed row and conflicts. This reproduces what a
  // genuine race collapses to at the database boundary, the same
  // simplification this codebase's other idempotency tests already use.
  let forceExistingCheckMiss = false;

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "update" = "select";
    let payload: any;
    const isExistingReceiptCheck = table === "restaurant_receipts";
    const suppressThisRead = isExistingReceiptCheck && forceExistingCheckMiss;
    if (suppressThisRead) forceExistingCheckMiss = false;
    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r: any) => r[col] === val);
        return api;
      },
      order: () => api,
      insert(row: any) {
        if (table === "restaurant_receipts" && receipts.some((r) => r.order_id === row.order_id)) {
          return {
            select: () => ({
              single: async () => ({
                data: null,
                error: { code: "23505", message: "duplicate key value violates unique constraint" },
              }),
            }),
          };
        }
        const stored = { id: `receipt-${++seq}`, reprint_count: 0, ...row };
        rowsFor(table).push(stored);
        return { select: () => ({ single: async () => ({ data: stored, error: null }) }) };
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

    function rowsFor(t: string): any[] {
      if (t === "restaurant_orders") return orders;
      if (t === "restaurant_order_items") return orderItems;
      if (t === "restaurant_payments") return payments;
      if (t === "restaurant_receipts") return receipts;
      return [];
    }

    async function resolve(mode: "single" | "maybeSingle" | "list") {
      const matches = (r: any) => filters.every((f) => f(r));
      if (op === "update") {
        const rows = rowsFor(table).filter(matches);
        for (const r of rows) Object.assign(r, payload);
        return { data: rows[0] ?? null, error: null };
      }
      const rows = suppressThisRead ? [] : rowsFor(table).filter(matches);
      if (mode === "list") return { data: rows, error: null };
      return {
        data: rows[0] ?? null,
        error: mode === "single" && !rows[0] ? { message: "not found" } : null,
      };
    }
    return api;
  }

  return {
    supabase: {
      from,
      rpc: async (fn: string) => {
        if (fn === "restaurant_next_document_number") return { data: "RCP-000001", error: null };
        return { data: null, error: null };
      },
    },
    receipts,
    simulateRaceOnNextCall() {
      forceExistingCheckMiss = true;
    },
  };
}

describe("issueReceipt — double-issue race (ME-06)", () => {
  it("a losing concurrent insert recovers the winner's receipt instead of throwing a raw duplicate-key error", async () => {
    const fixture = makeFixture();

    const first = await issueReceipt(fixture.supabase, USER, { tenantId: TENANT, orderId: ORDER });
    expect(first.order_id).toBe(ORDER);
    const winner = fixture.receipts[0];

    // Simulate the loser of a genuine concurrent race: its own "does a
    // receipt already exist?" read sees nothing (as it would if it ran
    // before the winner's INSERT committed), but the INSERT it then
    // attempts still hits the real, already-committed row and conflicts.
    fixture.simulateRaceOnNextCall();
    const second = await issueReceipt(fixture.supabase, USER, { tenantId: TENANT, orderId: ORDER });

    expect(second.id).toBe(winner.id);
    expect(fixture.receipts).toHaveLength(1);
  });
});
