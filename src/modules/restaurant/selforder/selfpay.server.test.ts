/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import {
  initiateGuestPayment,
  confirmGuestPaymentFromBrowser,
  confirmPesapalCallback,
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
const RETURN_URL = "https://example.test/order/table-1?pay=return";

function seedFor(orderOverrides: Partial<Record<string, unknown>> = {}) {
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
    payments: [],
    currencies: [],
  });
}

function fakeAdapter(overrides: Partial<PaymentProviderAdapter> = {}): PaymentProviderAdapter {
  return {
    name: "fake",
    initiate: async () => ({
      providerReference: "track-1",
      redirectUrl: "https://pesapal.test/checkout/track-1",
    }),
    // Matches seedFor's default order (total 11000, currency TZS) so the
    // happy-path tests reconcile cleanly without each needing its own override.
    verify: async () => ({ status: "paid", amount: 11000, currency: "TZS" }),
    ...overrides,
  };
}

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
  it("starts checkout for the server-derived amount, not a client-supplied one", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    let chargedAmount: number | null = null;
    let chargedCurrency: string | null = null;
    let merchantReference: string | null = null;
    const adapter = fakeAdapter({
      initiate: async (input) => {
        chargedAmount = input.amount;
        chargedCurrency = input.currency;
        merchantReference = input.merchantReference;
        return {
          providerReference: "track-1",
          redirectUrl: "https://pesapal.test/checkout/track-1",
        };
      },
    });
    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      adapter,
    );
    expect(chargedAmount).toBe(11000);
    expect(chargedCurrency).toBe("TZS");
    // The order id, not the order number — a webhook has no tableId to
    // scope by, so the merchant reference must resolve to the order alone.
    expect(merchantReference).toBe(ORDER);
    expect(result).toEqual({
      ok: true,
      status: "redirect",
      redirectUrl: "https://pesapal.test/checkout/track-1",
    });
  });

  it("does not start a checkout for an order that is already fully paid", async () => {
    const db = seedFor({ total: 11000, paid_total: 11000 });
    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "card" },
      RETURN_URL,
      fakeAdapter(),
    );
    expect(result).toEqual({ ok: false, reason: "already_paid" });
  });

  it("does not start a checkout for a closed/cancelled order", async () => {
    const db = seedFor({ total: 11000, paid_total: 0, status: "closed" });
    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "card" },
      RETURN_URL,
      fakeAdapter(),
    );
    expect(result).toEqual({ ok: false, reason: "not_payable", orderStatus: "closed" });
  });

  it("reports provider_not_configured rather than fabricating a checkout when no provider exists", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      null,
    );
    expect(result).toEqual({ ok: false, reason: "provider_not_configured" });
  });
});

describe("confirmGuestPaymentFromBrowser / confirmPesapalCallback", () => {
  it("marks the order paid only after independently re-verifying with the provider", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    let verifiedReference: string | null = null;
    const adapter = fakeAdapter({
      verify: async (input) => {
        verifiedReference = input.providerReference;
        return { status: "paid", amount: 11000, currency: "TZS" };
      },
    });
    const result = await confirmGuestPaymentFromBrowser(
      db as any,
      { tableId: TABLE, orderId: ORDER, orderTrackingId: "track-1" },
      adapter as any,
    );
    expect(verifiedReference).toBe("track-1");
    expect(result).toMatchObject({ ok: true, status: "paid" });
    const status = await guestOrderStatus(db as any, { tableId: TABLE, orderId: ORDER });
    expect(status.paidTotal).toBe(11000);
    expect(status.amountDue).toBe(0);
  });

  it("does not settle the order when the provider confirms a different amount than is owed", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const result = await confirmGuestPaymentFromBrowser(
      db as any,
      { tableId: TABLE, orderId: ORDER, orderTrackingId: "track-1" },
      // A "paid" status alone is not enough — Pesapal confirms it paid a
      // different amount than this order is actually owed.
      fakeAdapter({
        verify: async () => ({ status: "paid", amount: 5000, currency: "TZS" }),
      }) as any,
    );
    expect(result).toEqual({ ok: false, reason: "amount_mismatch" });
    const status = await guestOrderStatus(db as any, { tableId: TABLE, orderId: ORDER });
    expect(status.paidTotal).toBe(0);
  });

  it("does not settle the order when the provider confirms the right amount in the wrong currency", async () => {
    const db = seedFor({ total: 11000, paid_total: 0, currency: "TZS" });
    const result = await confirmGuestPaymentFromBrowser(
      db as any,
      { tableId: TABLE, orderId: ORDER, orderTrackingId: "track-1" },
      fakeAdapter({
        verify: async () => ({ status: "paid", amount: 11000, currency: "KES" }),
      }) as any,
    );
    expect(result).toEqual({ ok: false, reason: "amount_mismatch" });
  });

  it("does not mark the order paid when the provider reports a decline", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const result = await confirmGuestPaymentFromBrowser(
      db as any,
      { tableId: TABLE, orderId: ORDER, orderTrackingId: "track-1" },
      fakeAdapter({ verify: async () => ({ status: "failed", failureReason: "Failed" }) }) as any,
    );
    expect(result).toEqual({ ok: false, reason: "declined", detail: "Failed" });
    const status = await guestOrderStatus(db as any, { tableId: TABLE, orderId: ORDER });
    expect(status.paidTotal).toBe(0);
  });

  it("does not mark the order paid for a cancelled payment", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const result = await confirmGuestPaymentFromBrowser(
      db as any,
      { tableId: TABLE, orderId: ORDER, orderTrackingId: "track-1" },
      fakeAdapter({ verify: async () => ({ status: "failed", failureReason: "Invalid" }) }) as any,
    );
    expect(result).toEqual({ ok: false, reason: "declined", detail: "Invalid" });
  });

  it("does not mark the order paid for an expired payment attempt", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const result = await confirmGuestPaymentFromBrowser(
      db as any,
      { tableId: TABLE, orderId: ORDER, orderTrackingId: "track-1" },
      fakeAdapter({ verify: async () => ({ status: "expired" }) }) as any,
    );
    expect(result).toEqual({ ok: false, reason: "expired", detail: undefined });
  });

  it("reports pending without recording anything while the provider is still deciding", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const result = await confirmGuestPaymentFromBrowser(
      db as any,
      { tableId: TABLE, orderId: ORDER, orderTrackingId: "track-1" },
      fakeAdapter({ verify: async () => ({ status: "pending" }) }) as any,
    );
    expect(result).toEqual({ ok: true, status: "pending" });
    const status = await guestOrderStatus(db as any, { tableId: TABLE, orderId: ORDER });
    expect(status.paidTotal).toBe(0);
  });

  it("repeated browser refresh is safe — a second confirmation re-verifies but changes nothing once already paid", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const adapter = fakeAdapter();
    await confirmGuestPaymentFromBrowser(
      db as any,
      { tableId: TABLE, orderId: ORDER, orderTrackingId: "track-1" },
      adapter as any,
    );
    const second = await confirmGuestPaymentFromBrowser(
      db as any,
      { tableId: TABLE, orderId: ORDER, orderTrackingId: "track-1" },
      adapter as any,
    );
    // amountDue is now 0, so the second call short-circuits before ever
    // calling verify() again — the strongest idempotency guarantee available.
    expect(second).toEqual({ ok: false, reason: "already_paid" });
    const status = await guestOrderStatus(db as any, { tableId: TABLE, orderId: ORDER });
    expect(status.paidTotal).toBe(11000);
  });

  it("a duplicate callback for the same provider reference does not double-record even if somehow re-attempted mid-flight", async () => {
    // Simulates the IPN and the browser-return racing each other for the
    // same order: recordGuestPayment's own client_request_id unique index
    // (keyed on the provider reference) is the backstop even if the
    // already_paid short-circuit above weren't there.
    const db = seedFor({ total: 11000, paid_total: 0 });
    const { recordGuestPayment } = await import("../sales/pos.server");
    await recordGuestPayment(db as any, {
      tenantId: TENANT,
      orderId: ORDER,
      method: "mobile_money",
      amount: 11000,
      currency: "TZS",
      providerReference: "track-1",
    });
    const before = (db as any).from("restaurant_payments").filtered ?? undefined;
    const secondInsert = await recordGuestPayment(db as any, {
      tenantId: TENANT,
      orderId: ORDER,
      method: "mobile_money",
      amount: 11000,
      currency: "TZS",
      providerReference: "track-1",
    });
    expect(secondInsert.duplicate).toBe(true);
    void before;
  });

  it("the IPN path resolves the order from the provider's merchant reference alone, with no table or guest context", async () => {
    const db = seedFor({ total: 11000, paid_total: 0 });
    const result = await confirmPesapalCallback(
      db as any,
      { orderId: ORDER, providerReference: "track-1" },
      fakeAdapter() as any,
    );
    expect(result).toMatchObject({ ok: true, status: "paid" });
  });

  it("the IPN path reports order_not_found for an unrecognized merchant reference, never guessing", async () => {
    const db = seedFor();
    const result = await confirmPesapalCallback(
      db as any,
      { orderId: "no-such-order", providerReference: "track-1" },
      fakeAdapter() as any,
    );
    expect(result).toEqual({ ok: false, reason: "order_not_found" });
  });
});
