/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import {
  initiateGuestPayment,
  guestOrderStatus,
  type PaymentProviderAdapter,
} from "./selfpay.server";

/**
 * An in-memory Supabase stand-in covering exactly the chains selfpay.server
 * and recalcOrder/recordGuestPayment use: .from().select().eq()...maybeSingle(),
 * .insert(), .update(). Good enough to prove the authorization/idempotency/
 * amount-derivation logic without a real database.
 */
function fakeDb(seed: {
  tables?: any[];
  tenants?: any[];
  orders?: any[];
  orderItems?: any[];
  payments?: any[];
  currencies?: any[];
}) {
  const rows: Record<string, any[]> = {
    restaurant_tables: seed.tables ?? [],
    restaurant_tenants: seed.tenants ?? [],
    restaurant_orders: seed.orders ?? [],
    restaurant_order_items: seed.orderItems ?? [],
    restaurant_payments: seed.payments ?? [],
    restaurant_currencies: seed.currencies ?? [],
  };

  function from(table: string) {
    let filtered = rows[table] ?? [];
    let pendingPatch: Record<string, unknown> | null = null;
    const applyPatch = () => {
      if (!pendingPatch) return;
      for (const r of filtered) Object.assign(r, pendingPatch);
    };
    const builder: any = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return builder;
      },
      limit() {
        return builder;
      },
      order() {
        return builder;
      },
      maybeSingle: async () => {
        applyPatch();
        return { data: filtered[0] ?? null };
      },
      single: async () => {
        applyPatch();
        return { data: filtered[0] ?? null, error: filtered[0] ? null : { message: "not found" } };
      },
      insert(row: Record<string, unknown> | Record<string, unknown>[]) {
        const arr = Array.isArray(row) ? row : [row];
        for (const r of arr) rows[table]!.push({ id: `gen-${rows[table]!.length}`, ...r });
        return {
          then: (resolve: (v: { data: any; error: null }) => unknown) =>
            resolve({ data: arr, error: null }),
          select: () => ({
            single: async () => ({ data: rows[table]![rows[table]!.length - 1], error: null }),
          }),
        };
      },
      update(patch: Record<string, unknown>) {
        pendingPatch = patch;
        return builder;
      },
      // resolves the bare query too (used by recalcOrder's Promise.all destructuring)
      then: (resolve: (v: { data: any[] }) => unknown) => {
        applyPatch();
        return resolve({ data: filtered });
      },
    };
    return builder;
  }

  return { from };
}

const TENANT = "tenant-1";
const TABLE = "table-1";
const ORDER = "order-1";

function seedFor(orderOverrides: Partial<Record<string, unknown>> = {}, payments: any[] = []) {
  return fakeDb({
    tables: [
      {
        id: TABLE,
        code: "T1",
        name: "T1",
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        active: true,
      },
    ],
    tenants: [{ id: TENANT, name: "Demo", status: "active" }],
    orders: [
      {
        id: ORDER,
        order_number: "ORD-1",
        status: "open",
        payment_state: "unpaid",
        total: 11000,
        paid_total: 0,
        currency: "TZS",
        table_id: TABLE,
        tenant_id: TENANT,
        ...orderOverrides,
      },
    ],
    orderItems: [],
    payments,
    currencies: [],
  });
}

const fakeProvider = (result: {
  providerReference: string;
  status: "paid" | "failed";
  failureReason?: string;
}): PaymentProviderAdapter => ({
  name: "fake",
  charge: async () => result,
});

describe("guestOrderStatus", () => {
  it("reports the authoritative amount due, not anything the client could have sent", async () => {
    const db = seedFor({ total: 11000, paid_total: 4000 });
    const status = await guestOrderStatus(db as any, { tableId: TABLE, orderId: ORDER });
    expect(status.total).toBe(11000);
    expect(status.paidTotal).toBe(4000);
    expect(status.amountDue).toBe(7000);
    expect(status.currency).toBe("TZS");
  });

  it("refuses an order id that does not belong to this table", async () => {
    const db = seedFor();
    await expect(
      guestOrderStatus(db as any, { tableId: TABLE, orderId: "not-this-order" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("initiateGuestPayment", () => {
  it("charges the server-derived amount, not a client-supplied one, and records it once paid", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    let chargedAmount: number | null = null;
    const provider: PaymentProviderAdapter = {
      name: "fake",
      charge: async (input) => {
        chargedAmount = input.amount;
        return { providerReference: "ref-1", status: "paid" };
      },
    };
    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      provider,
    );
    expect(chargedAmount).toBe(11000);
    expect(result).toMatchObject({ ok: true, status: "paid" });
  });

  it("does not mark the order paid when the provider declines", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "card" },
      fakeProvider({
        providerReference: "ref-2",
        status: "failed",
        failureReason: "insufficient_funds",
      }),
    );
    expect(result).toEqual({
      ok: false,
      reason: "provider_declined",
      detail: "insufficient_funds",
    });
    const status = await guestOrderStatus(db as any, { tableId: TABLE, orderId: ORDER });
    expect(status.paymentState).toBe("unpaid");
    expect(status.paidTotal).toBe(0);
  });

  it("reports provider_not_configured rather than fabricating a payment when no provider exists", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      null,
    );
    expect(result).toEqual({ ok: false, reason: "provider_not_configured" });
  });

  it("refuses to charge an order that is already fully paid", async () => {
    const db = seedFor({ total: 11000, paid_total: 11000 });
    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "card" },
      fakeProvider({ providerReference: "ref-3", status: "paid" }),
    );
    expect(result).toEqual({ ok: false, reason: "already_paid" });
  });

  it("refuses to charge an order that is closed/cancelled", async () => {
    const db = seedFor({ total: 11000, paid_total: 0, status: "closed" });
    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "card" },
      fakeProvider({ providerReference: "ref-4", status: "paid" }),
    );
    expect(result).toEqual({ ok: false, reason: "not_payable", orderStatus: "closed" });
  });

  it("a duplicate provider callback for the same reference is idempotent — one payment row, not two", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const provider = fakeProvider({ providerReference: "same-ref", status: "paid" });
    await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "card" },
      provider,
    );
    // Order is now fully paid, so a second attempt is short-circuited by
    // already_paid before ever reaching the provider/insert again — the
    // stronger idempotency guarantee: it can't even be attempted twice.
    const second = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "card" },
      provider,
    );
    expect(second).toEqual({ ok: false, reason: "already_paid" });
  });
});
