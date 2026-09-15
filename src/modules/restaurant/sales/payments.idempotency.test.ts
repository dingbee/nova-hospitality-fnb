/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-03 — payment double-submission protection.
 *
 * recordPayment() (the admin order-pad payment path) had NO idempotency
 * guard at all: a retried request (client timeout, double form-submit)
 * unconditionally inserted a second real payment row for the same order.
 * takePosPayment()/recordGuestPayment() had a client_request_id guard, but
 * it was a pre-check-then-insert: two concurrent requests carrying the same
 * clientRequestId could both read "no existing payment" before either had
 * written it, and the loser's insert then hit the
 * (tenant_id, client_request_id) unique index and surfaced a raw
 * duplicate-key Postgres error instead of resolving idempotently.
 *
 * All three now insert unconditionally and recover on a 23505 conflict —
 * the same pattern createGuestOrder already used for orders — so these
 * tests exercise that recovery path directly: since the fix removes the
 * pre-check entirely, calling the same operation twice in sequence (which
 * is exactly what a genuine concurrent race collapses to at the database
 * boundary — the loser always sees the unique-index conflict at insert
 * time, whether the winner beat it by a millisecond or by a full
 * round-trip) is sufficient to prove the recovery path, not just the
 * happy path.
 */
import { describe, expect, it, vi } from "vitest";
import { recordPayment } from "./sales.server";
import { takePosPayment, recordGuestPayment } from "./pos.server";

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
}));
vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn(async () => ({ delivered: true, duplicate: false })),
}));

const TENANT = "tenant-1";
const ORDER = "order-1";
const USER = "user-1";

function fakeDb(seed: { orders: any[]; orderItems: any[]; payments: any[] }) {
  const tables: Record<string, any[]> = {
    restaurant_orders: seed.orders,
    restaurant_order_items: seed.orderItems,
    restaurant_payments: seed.payments,
  };
  let seq = 0;

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered = rows;
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return api;
      },
      // recalcOrder awaits the builder directly (no .single()/.maybeSingle())
      // for its list reads, exactly like the real supabase-js
      // PostgrestFilterBuilder — it is thenable, not a plain object.
      then: (resolve: (v: { data: any[]; error: null }) => unknown) =>
        resolve({ data: filtered, error: null }),
      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      single: async () =>
        filtered.length
          ? { data: filtered[0], error: null }
          : { data: null, error: { message: `${table}: not found` } },
      insert: (row: any) => {
        if (
          table === "restaurant_payments" &&
          row.client_request_id != null &&
          rows.some(
            (r) => r.tenant_id === row.tenant_id && r.client_request_id === row.client_request_id,
          )
        ) {
          return {
            select: () => ({
              single: async () => ({
                data: null,
                error: {
                  code: "23505",
                  message:
                    'duplicate key value violates unique constraint "restaurant_payments_client_request_idx"',
                },
              }),
            }),
          };
        }
        const stored = { id: `payment-${++seq}`, ...row };
        rows.push(stored);
        filtered = [stored];
        return { select: () => ({ single: async () => ({ data: stored, error: null }) }) };
      },
      update: (patch: any) => {
        const target: any = {
          eq: (col: string, val: unknown) => {
            const matched = rows.filter((r) => r[col] === val);
            for (const r of matched) Object.assign(r, patch);
            return target;
          },
        };
        return target;
      },
    };
    return api;
  }

  return { from, tables } as any;
}

function baseOrder() {
  return {
    id: ORDER,
    tenant_id: TENANT,
    property_id: "prop-1",
    location_id: "loc-1",
    status: "open",
    total: 100,
    paid_total: 0,
    currency: "TZS",
  };
}

describe("recordPayment — double submission (ME-03)", () => {
  it("a retried request with the same clientRequestId never creates a second payment row", async () => {
    const sb = fakeDb({ orders: [baseOrder()], orderItems: [], payments: [] });

    const first = await recordPayment(sb, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      method: "cash",
      amount: 40,
      state: "paid",
      clientRequestId: "retry-key-1",
    } as any);
    expect(first.duplicate).toBe(false);

    const second = await recordPayment(sb, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      method: "cash",
      amount: 40,
      state: "paid",
      clientRequestId: "retry-key-1",
    } as any);
    expect(second.duplicate).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);

    const stored = (sb as any).tables.restaurant_payments.filter(
      (r: any) => r.client_request_id === "retry-key-1",
    );
    expect(stored).toHaveLength(1);
  });

  it("without a clientRequestId, behaviour is unchanged (no accidental dedupe of distinct payments)", async () => {
    const sb = fakeDb({ orders: [baseOrder()], orderItems: [], payments: [] });
    const a = await recordPayment(sb, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      method: "cash",
      amount: 10,
      state: "paid",
    } as any);
    const b = await recordPayment(sb, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      method: "cash",
      amount: 10,
      state: "paid",
    } as any);
    expect(a.payment.id).not.toBe(b.payment.id);
  });
});

describe("takePosPayment — double submission (ME-03)", () => {
  it("a retried request with the same clientRequestId resolves idempotently instead of throwing a raw duplicate-key error", async () => {
    const sb = fakeDb({ orders: [baseOrder()], orderItems: [], payments: [] });
    const input = {
      tenantId: TENANT,
      orderId: ORDER,
      method: "cash",
      amount: 40,
      state: "paid",
      clientRequestId: "pos-retry-1",
    } as any;

    const first = await takePosPayment(sb, USER, input);
    expect(first.duplicate).toBe(false);

    // Previously: the pre-check-then-insert shape meant a second call whose
    // insert lost the race threw the raw Postgres unique-violation error
    // instead of returning gracefully. It must now resolve without throwing.
    const second = await takePosPayment(sb, USER, input);
    expect(second.duplicate).toBe(true);
  });
});

describe("recordGuestPayment — double submission (ME-03)", () => {
  it("a retried guest payment with the same providerReference resolves idempotently", async () => {
    const sb = fakeDb({ orders: [baseOrder()], orderItems: [], payments: [] });
    const input = {
      tenantId: TENANT,
      orderId: ORDER,
      method: "mobile_money",
      amount: 40,
      currency: "TZS",
      providerReference: "provider-ref-1",
    };

    const first = await recordGuestPayment(sb, input);
    expect(first.duplicate).toBe(false);

    const second = await recordGuestPayment(sb, input);
    expect(second.duplicate).toBe(true);
  });
});
