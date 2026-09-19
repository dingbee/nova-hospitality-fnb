/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { initiateGuestPayment, type PaymentProviderAdapter } from "./selfpay.server";

/**
 * Regression for a real operational-integrity defect: initiateGuestPayment
 * derived the payable amount fresh from the order but never claimed
 * anything before calling the Pesapal adapter. Two concurrent initiation
 * requests for the same order — a double-tapped "Pay" button, two open
 * browser tabs, a client retry — each independently called
 * provider.initiate(), each creating its own real hosted-checkout session
 * with its own order_tracking_id. recordGuestPayment's idempotency dedupes
 * a repeated confirmation of the *same* provider reference (via
 * restaurant_payments' (tenant_id, client_request_id) unique index) — it
 * never protected against two genuinely different sessions for the same
 * order both being completed and both being recorded, which would overpay
 * the order.
 *
 * Fixed with a compare-and-swap claim on restaurant_orders itself (see
 * selfpay.server.ts's initiateGuestPayment) — this file proves the claim
 * holds under a genuine simulated concurrent interleaving, not merely two
 * sequential calls.
 */

const TENANT = "tenant-1";
const TABLE = "table-1";
const ORDER = "order-1";
const RETURN_URL = "https://example.test/order/table-1?pay=return";

/**
 * A slightly richer fake than a plain in-memory table: `onFirstClaimAttempt`
 * fires exactly once, at the moment the *first* caller's claim UPDATE
 * evaluates its WHERE clause, mutating the real underlying row — simulating
 * a second, truly concurrent caller's write landing in that same instant.
 * This is the same technique used for kitchen/advanceTicket.test.ts's CAS
 * regression: a synchronous in-memory fake can't produce a real race by
 * itself, so the interleaving is injected deterministically instead of
 * relying on two sequential calls, which would prove nothing about the
 * compare-and-swap logic itself.
 */
function fakeDb(order: Record<string, any>, opts: { onFirstClaimAttempt?: () => void } = {}) {
  const tables = [
    {
      id: TABLE,
      code: "T1",
      name: "T1",
      tenant_id: TENANT,
      property_id: null,
      location_id: null,
      active: true,
    },
  ];
  const tenants = [{ id: TENANT, name: "Demo", status: "active" }];
  const orders = [order];
  const currencies: any[] = [];
  let claimAttempts = 0;

  function from(table: string) {
    const rows =
      table === "restaurant_tables"
        ? tables
        : table === "restaurant_tenants"
          ? tenants
          : table === "restaurant_currencies"
            ? currencies
            : orders;
    let filtered = rows;
    let mode: "select" | "update" = "select";
    let patch: Record<string, unknown> | null = null;
    let isClaimAttempt = false;
    const api: any = {
      select: () => api,
      limit: () => api,
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r: any) => r[col] === val);
        return api;
      },
      or(clause: string) {
        isClaimAttempt = table === "restaurant_orders" && mode === "update";
        if (isClaimAttempt) {
          claimAttempts += 1;
          // Fires BEFORE the WHERE clause is evaluated, simulating a
          // concurrent caller's claim having already committed by the time
          // this UPDATE statement actually runs — exactly what a real
          // Postgres UPDATE ... WHERE evaluates against (the latest
          // committed row), never a snapshot from before this call started.
          if (claimAttempts === 1) opts.onFirstClaimAttempt?.();
        }
        const conditions = clause.split(",").map((c) => {
          const m = c.match(/^([^.]+)\.([^.]+)\.(.*)$/)!;
          return { col: m[1]!, op: m[2]!, val: m[3]! };
        });
        filtered = filtered.filter((r: any) =>
          conditions.some((c) => {
            if (c.op === "is") return r[c.col] == null;
            if (c.op === "lt") return r[c.col] != null && String(r[c.col]) < c.val;
            return false;
          }),
        );
        return api;
      },
      update(p: Record<string, unknown>) {
        mode = "update";
        patch = p;
        return api;
      },
      maybeSingle: async () => {
        const m = filtered;
        if (mode === "update") for (const r of m) Object.assign(r, patch);
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      single: async () => {
        const m = filtered;
        if (mode === "update") for (const r of m) Object.assign(r, patch);
        return { data: m[0] ? { ...m[0] } : null, error: m[0] ? null : { message: "not found" } };
      },
      then: (resolve: any) => {
        const m = filtered;
        if (mode === "update") for (const r of m) Object.assign(r, patch);
        return resolve({ data: m });
      },
    };
    return api;
  }

  return { from: (table: string) => from(table) };
}

function baseOrder(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: ORDER,
    order_number: "ORD-1",
    status: "open",
    payment_state: "unpaid",
    total: 11000,
    paid_total: 0,
    currency: "TZS",
    table_id: TABLE,
    tenant_id: TENANT,
    guest_payment_session_reference: null,
    guest_payment_session_redirect_url: null,
    guest_payment_session_expires_at: null,
    ...overrides,
  };
}

function countingAdapter(): PaymentProviderAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    name: "fake",
    async initiate(input: { merchantReference: string }) {
      adapter.calls += 1;
      return {
        providerReference: `track-${adapter.calls}`,
        redirectUrl: `https://pesapal.test/checkout/track-${adapter.calls}`,
      };
    },
    async verify() {
      return { status: "paid" as const, amount: 11000, currency: "TZS" };
    },
  };
  return adapter;
}

describe("initiateGuestPayment — concurrency claim", () => {
  it("a genuinely concurrent second claim attempt never reaches the provider while the first is still mid-flight", async () => {
    const order = baseOrder();
    const adapter = countingAdapter();
    const db = fakeDb(order, {
      onFirstClaimAttempt: () => {
        // Simulates another caller's claim landing in the exact instant the
        // first caller's own claim UPDATE is evaluated: the row now shows a
        // live "in progress" placeholder before the first caller's own
        // conditional filter is applied.
        (order as any).guest_payment_session_reference = "__initiating__:other-caller-token";
        (order as any).guest_payment_session_expires_at = new Date(
          Date.now() + 30_000,
        ).toISOString();
      },
    });

    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      adapter,
    );

    expect(result).toEqual({ ok: false, reason: "initiation_in_progress" });
    expect(adapter.calls).toBe(0); // never called Pesapal — the race was caught before that
  });

  it("a duplicate call while a live session already exists is handed the same redirect, never a second Pesapal session", async () => {
    const order = baseOrder({
      guest_payment_session_reference: "track-1",
      guest_payment_session_redirect_url: "https://pesapal.test/checkout/track-1",
      guest_payment_session_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const adapter = countingAdapter();
    const db = fakeDb(order);

    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      adapter,
    );

    expect(result).toEqual({
      ok: true,
      status: "redirect",
      redirectUrl: "https://pesapal.test/checkout/track-1",
    });
    expect(adapter.calls).toBe(0); // reused the existing session — no second call
  });

  it("an expired stale claim does not block a genuine new payment attempt", async () => {
    const order = baseOrder({
      guest_payment_session_reference: "track-old",
      guest_payment_session_redirect_url: "https://pesapal.test/checkout/track-old",
      guest_payment_session_expires_at: new Date(Date.now() - 1000).toISOString(), // already expired
    });
    const adapter = countingAdapter();
    const db = fakeDb(order);

    const result = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      adapter,
    );

    expect(result.ok).toBe(true);
    expect(adapter.calls).toBe(1); // a fresh session was started
    expect(order.guest_payment_session_reference).toBe("track-1");
  });

  it("a provider failure releases the claim so a real retry is never permanently blocked", async () => {
    const order = baseOrder();
    const failingAdapter: PaymentProviderAdapter = {
      name: "fake",
      initiate: async () => {
        throw new Error("Pesapal unreachable");
      },
      verify: async () => ({ status: "paid", amount: 11000, currency: "TZS" }),
    };
    const db = fakeDb(order);

    await expect(
      initiateGuestPayment(
        db as any,
        { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
        RETURN_URL,
        failingAdapter,
      ),
    ).rejects.toThrow(/pesapal unreachable/i);

    expect(order.guest_payment_session_reference).toBeNull();
    expect(order.guest_payment_session_expires_at).toBeNull();

    // A genuine retry afterward succeeds normally.
    const adapter = countingAdapter();
    const retry = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      adapter,
    );
    expect(retry.ok).toBe(true);
    expect(adapter.calls).toBe(1);
  });
});

/**
 * Ownership-qualified CAS: claiming the slot is not enough on its own — a
 * caller whose own provider.initiate() call outlives GUEST_PAYMENT_CLAIM_TTL_MS
 * must never finalize or release the slot once someone else (B) has since
 * claimed and completed a session. These tests genuinely overlap two
 * initiateGuestPayment calls (A's provider call is a promise this test
 * controls and resolves only after B has fully finished), not two
 * sequential calls — proving the finalize/release writes are themselves
 * ownership-conditioned, not blind.
 */
describe("initiateGuestPayment — ownership survives a slow, late-arriving provider response", () => {
  /** Flushes every currently-pending microtask chain, however many awaits deep. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("claim A expires, claim B completes, then A's late SUCCESS must not overwrite B's live session", async () => {
    const order = baseOrder();
    const db = fakeDb(order);

    let resolveA!: (v: { providerReference: string; redirectUrl: string }) => void;
    const aProviderCall = new Promise<{ providerReference: string; redirectUrl: string }>(
      (resolve) => {
        resolveA = resolve;
      },
    );
    const adapterA: PaymentProviderAdapter = {
      name: "fake",
      initiate: async () => aProviderCall, // hangs until resolveA is called below
      verify: async () => ({ status: "paid", amount: 11000, currency: "TZS" }),
    };

    // Start A: it claims the slot, then blocks awaiting the provider.
    const aCall = initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      adapterA,
    );
    await flush();
    await flush();

    // A's claim has now "expired" from a slow round trip.
    (order as any).guest_payment_session_expires_at = new Date(Date.now() - 1000).toISOString();

    // B claims fresh and completes fully before A's provider call returns.
    const adapterB = countingAdapter();
    const bResult = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      adapterB,
    );
    expect(bResult).toEqual({ ok: true, status: "redirect", redirectUrl: expect.any(String) });
    const bReference = order.guest_payment_session_reference;
    const bRedirect = order.guest_payment_session_redirect_url;
    const bExpiry = order.guest_payment_session_expires_at;

    // A's slow provider call finally resolves — a late success.
    resolveA({
      providerReference: "track-A-late",
      redirectUrl: "https://pesapal.test/checkout/track-A-late",
    });
    const aResult = await aCall;

    // A still gets back the real session it created — it isn't lied to.
    expect(aResult).toEqual({
      ok: true,
      status: "redirect",
      redirectUrl: "https://pesapal.test/checkout/track-A-late",
    });
    // But B's session remains the order's authoritative one, untouched.
    expect(order.guest_payment_session_reference).toBe(bReference);
    expect(order.guest_payment_session_redirect_url).toBe(bRedirect);
    expect(order.guest_payment_session_expires_at).toBe(bExpiry);
  });

  it("claim A expires, claim B completes, then A's late FAILURE must not clear B's live session", async () => {
    const order = baseOrder();
    const db = fakeDb(order);

    let rejectA!: (err: Error) => void;
    const aProviderCall = new Promise<never>((_resolve, reject) => {
      rejectA = reject;
    });
    const adapterA: PaymentProviderAdapter = {
      name: "fake",
      initiate: async () => aProviderCall,
      verify: async () => ({ status: "paid", amount: 11000, currency: "TZS" }),
    };

    const aCall = initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      adapterA,
    );
    await flush();
    await flush();

    (order as any).guest_payment_session_expires_at = new Date(Date.now() - 1000).toISOString();

    const adapterB = countingAdapter();
    const bResult = await initiateGuestPayment(
      db as any,
      { tableId: TABLE, orderId: ORDER, method: "mobile_money" },
      RETURN_URL,
      adapterB,
    );
    expect(bResult.ok).toBe(true);
    const bReference = order.guest_payment_session_reference;
    const bRedirect = order.guest_payment_session_redirect_url;
    const bExpiry = order.guest_payment_session_expires_at;

    // A's slow provider call finally rejects — a late failure.
    rejectA(new Error("Pesapal timeout"));
    await expect(aCall).rejects.toThrow(/pesapal timeout/i);

    // B's live session must survive A's (ownerless) cleanup attempt intact.
    expect(order.guest_payment_session_reference).toBe(bReference);
    expect(order.guest_payment_session_redirect_url).toBe(bRedirect);
    expect(order.guest_payment_session_expires_at).toBe(bExpiry);
  });
});
