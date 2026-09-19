/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Self-order payment — the same authorization boundary as the rest of this
 * module (resolveGuestTableContext: a table id, nothing else), applied to
 * "what is owed on this order" and "pay it".
 *
 * Nothing here trusts the client for amount, currency, discount, tax, or
 * payment/order status. The payable amount is always order.total -
 * order.paid_total, read fresh from the order this instant — recalcOrder
 * (in sales.server.ts) is the only place those totals are computed, and it
 * is unchanged by this module.
 *
 * The interface below is two-phase (initiate -> verify), not a single
 * synchronous charge: every real provider capable of TZS/mobile-money/card
 * (Pesapal included) works by redirecting the payer to a hosted page and
 * confirming the outcome afterwards, never by returning paid/failed inline.
 * Modelling it as a single call would have meant either lying about what
 * happened or trusting the browser's word for it — this keeps "was it
 * actually paid" a server-verified question, asked via verify(), always.
 */
import { recordGuestPayment } from "../sales/pos.server";
import { resolveGuestTableContext } from "./selforder.server";
import { createPesapalAdapter } from "./providers/pesapal.server";
import type { InitiateGuestPaymentInput } from "./selfpay.contracts";

type Sb = any;

/**
 * The one canonical "is this order still open to take a payment against"
 * definition — reused by every automated/unattended collection path
 * (guest Pesapal/card here, Mobile Money's requestMobileMoneyCollection in
 * mobilemoney.server.ts) so a second, competing definition of "payable"
 * never exists. Cash/card entered directly by a staff member at the till
 * (takePosPayment) is a distinct, attended, capability-gated flow and
 * intentionally does not go through this check.
 */
export const PAYABLE_ORDER_STATUSES = new Set(["open", "sent", "served"]);

/** A guest's own order, and nothing else — scoped by table AND order id, mirroring how a receipt share token scopes access. */
async function loadGuestOrder(sb: Sb, tenantId: string, tableId: string, orderId: string) {
  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, payment_state, total, paid_total, currency, table_id")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .eq("table_id", tableId)
    .maybeSingle();
  if (!order) throw new Error("Order not found for this table.");
  return order;
}

/**
 * An order looked up with no table in hand at all — the shape a
 * server-to-server provider callback arrives in (a provider reference,
 * nothing else). Scoped only by tenant, derived from the order row itself,
 * never accepted as a parameter.
 */
async function loadOrderByPesapalMerchantReference(sb: Sb, orderId: string) {
  const { data: order } = await sb
    .from("restaurant_orders")
    .select(
      "id, tenant_id, order_number, status, payment_state, total, paid_total, currency, table_id",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return null;
  return order;
}

/** The redacted shape both the guest confirmation screen and a payment-outcome response share — order number, totals, payment state, nothing internal. */
function toOrderStatus(order: {
  order_number: string;
  status: string;
  payment_state: string;
  total: number;
  paid_total: number;
  currency: string;
}) {
  return {
    orderNumber: order.order_number,
    status: order.status,
    paymentState: order.payment_state,
    total: Number(order.total),
    paidTotal: Number(order.paid_total),
    amountDue: Math.max(0, Number(order.total) - Number(order.paid_total)),
    currency: order.currency,
  };
}

/** Redacted order/bill status for the self-order confirmation screen. */
export async function guestOrderStatus(sb: Sb, input: { tableId: string; orderId: string }) {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrder(sb, table.tenantId, input.tableId, input.orderId);
  return toOrderStatus(order);
}

/** The same redacted status, scoped by tenant + order id only — for a caller (a provider callback) that has no table in hand. */
async function orderStatusByTenantAndId(sb: Sb, tenantId: string, orderId: string) {
  const { data } = await sb
    .from("restaurant_orders")
    .select("order_number, status, payment_state, total, paid_total, currency")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .maybeSingle();
  return toOrderStatus(data);
}

/**
 * A real, callable payment provider. Nothing in this codebase implemented
 * one until now — see getConfiguredProvider. Kept as an interface so a
 * provider (Pesapal today) is the only thing an integration needs to
 * supply; none of the authorization, amount-derivation or idempotency logic
 * in this file changes.
 */
export type PaymentProviderAdapter = {
  name: string;
  /**
   * Starts a hosted checkout for a server-derived amount/currency. Returns
   * where to send the payer — nothing is recorded as paid by this call.
   * `merchantReference` is this codebase's own order id, so a later
   * server-to-server callback (which never carries a tableId) can be
   * resolved back to the right order with no separate mapping table.
   *
   * `signal` aborts once this attempt's claim window elapses (see
   * initiateGuestPayment) — an adapter must forward it to its own
   * outbound call(s) so an expired claim's request is actually cancelled,
   * not merely ignored. Without that, the underlying HTTP call keeps
   * running after we've internally given up on it, and could still
   * complete with a real, independent session after a second caller has
   * already claimed and started its own — the exact "two live provider
   * sessions" outcome this interface exists to prevent. A caller with no
   * meaningful way to cancel its own transport may ignore the signal, but
   * then cannot claim to uphold the single-live-initiation invariant.
   */
  initiate(input: {
    amount: number;
    currency: string;
    merchantReference: string;
    description: string;
    returnUrl: string;
    signal?: AbortSignal;
  }): Promise<{ providerReference: string; redirectUrl: string }>;
  /**
   * The only source of truth for "did this actually get paid" — always
   * re-queried from the provider, never inferred from a redirect or a
   * webhook payload's own claimed status. amount/currency are the
   * provider's own record of what was actually paid, required whenever
   * status is "paid" — confirmGuestPayment reconciles them against the
   * order's own amount due before recording anything, rather than trusting
   * a "paid" status alone.
   */
  verify(input: {
    providerReference: string;
  }): Promise<
    | { status: "paid"; amount: number; currency: string }
    | { status: "failed" | "pending" | "expired"; failureReason?: string }
  >;
};

/**
 * No payment provider is configured in this deployment unless the required
 * PESAPAL_* environment variables are present (see providers/pesapal.server
 * for the exact names). This returns null until they exist; nothing here
 * fabricates a provider.
 */
export function getConfiguredProvider(): PaymentProviderAdapter | null {
  return createPesapalAdapter();
}

export type InitiateGuestPaymentResult =
  | { ok: true; status: "redirect"; redirectUrl: string }
  | { ok: false; reason: "already_paid" }
  | { ok: false; reason: "not_payable"; orderStatus: string }
  | { ok: false; reason: "provider_not_configured" }
  | { ok: false; reason: "initiation_in_progress" };

/**
 * Placeholder claim prefix while a call to the provider is in flight — never
 * a real provider reference. Each attempt gets its own random token after
 * this prefix (see claimTokenValue), not a single shared constant: the
 * finalize/release steps below must be able to tell "is the row still under
 * *my* claim" apart from "someone else's claim has already replaced mine",
 * which a shared placeholder value can't distinguish.
 */
const GUEST_PAYMENT_INITIATING_PREFIX = "__initiating__:";
function claimTokenValue(): string {
  return `${GUEST_PAYMENT_INITIATING_PREFIX}${crypto.randomUUID()}`;
}
function isPlaceholder(reference: string | null | undefined): boolean {
  return typeof reference === "string" && reference.startsWith(GUEST_PAYMENT_INITIATING_PREFIX);
}
/**
 * How long an "actively calling the provider" claim is honoured before
 * another caller may retry — generous over any realistic SubmitOrderRequest
 * round trip, but never held for anywhere near the guest's whole time on
 * the hosted checkout page.
 */
const GUEST_PAYMENT_CLAIM_TTL_MS = 30_000;
/** How long a completed session's own redirect is handed back to a duplicate initiate call instead of starting a second Pesapal session. */
const GUEST_PAYMENT_SESSION_TTL_MS = 30 * 60_000;

type PendingSession = {
  guest_payment_session_reference: string | null;
  guest_payment_session_redirect_url: string | null;
  guest_payment_session_expires_at: string | null;
} | null;

function isLiveSession(session: PendingSession): boolean {
  if (!session?.guest_payment_session_expires_at) return false;
  return new Date(session.guest_payment_session_expires_at).getTime() > Date.now();
}

/**
 * Concurrency claim: two concurrent initiateGuestPayment calls for the
 * same order — a double-tapped "Pay" button, two open
 * browser tabs, a client retry — must not each independently call the
 * Pesapal adapter, since that would create two real, independent hosted
 * checkout sessions with two different provider references. recordGuest
 * Payment's existing idempotency dedupes a repeated confirmation of the
 * *same* provider reference; it never protected against two genuinely
 * different sessions for the same order both completing and both being
 * recorded, which would overpay the order.
 *
 * This is a single compare-and-swap UPDATE on the order row — evaluated by
 * Postgres against the current committed row, not against a value either
 * caller read earlier — so at most one caller can ever hold the claim at a
 * time. Every other concurrent caller is handed back the winner's own live
 * session (same redirect, no second Pesapal call) or, in the rare
 * sub-second window where the winner is still mid-flight to the provider,
 * told to retry shortly.
 *
 * Ownership under a slow provider response: claiming the slot is not enough
 * on its own — a caller whose own provider.initiate() call outlives its
 * GUEST_PAYMENT_CLAIM_TTL_MS window must never finalize or release the slot
 * once someone else has since claimed it too. Each attempt therefore claims
 * with its own random token (claimTokenValue), and both the success
 * (finalize) and failure (release) writes are themselves conditioned on
 * that exact token still being present — an ownership-qualified CAS, not a
 * blind write — so a late-arriving result from an expired claim can never
 * overwrite or clear a newer claimant's live session.
 *
 * That alone still leaves the DB claim and the actual outbound call to the
 * provider as two independently-lived things: a slow SubmitOrderRequest
 * could keep running against Pesapal's servers well after we've internally
 * decided its claim expired, and could still complete with a second, real,
 * independent checkout session once a new caller has already claimed and
 * started its own — the exact "two live provider sessions" outcome this
 * whole mechanism exists to prevent, just delayed rather than closed. So
 * the claim TTL is not only a DB bookkeeping window: an AbortController
 * tied to that identical deadline is threaded into provider.initiate()
 * itself, so the moment a claim would be treated as expired, this
 * attempt's own request to the provider has already been cancelled and can
 * no longer independently produce a session at all — at any instant, at
 * most one live call to the provider exists for a given order, not merely
 * at most one DB row claiming to own one.
 */
export async function initiateGuestPayment(
  sb: Sb,
  input: InitiateGuestPaymentInput,
  returnUrl: string,
  provider: PaymentProviderAdapter | null = getConfiguredProvider(),
): Promise<InitiateGuestPaymentResult> {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrder(sb, table.tenantId, input.tableId, input.orderId);

  if (!PAYABLE_ORDER_STATUSES.has(order.status)) {
    return { ok: false, reason: "not_payable", orderStatus: order.status };
  }
  const amountDue = Math.max(0, Number(order.total) - Number(order.paid_total));
  if (amountDue <= 0) {
    return { ok: false, reason: "already_paid" };
  }
  if (!provider) {
    return { ok: false, reason: "provider_not_configured" };
  }

  const myClaimToken = claimTokenValue();
  const nowIso = new Date().toISOString();
  const { data: claimed } = await sb
    .from("restaurant_orders")
    .update({
      guest_payment_session_reference: myClaimToken,
      guest_payment_session_redirect_url: null,
      guest_payment_session_expires_at: new Date(
        Date.now() + GUEST_PAYMENT_CLAIM_TTL_MS,
      ).toISOString(),
    })
    .eq("tenant_id", table.tenantId)
    .eq("id", order.id)
    .or(`guest_payment_session_expires_at.is.null,guest_payment_session_expires_at.lt.${nowIso}`)
    .select("id")
    .maybeSingle();

  if (!claimed) {
    // Lost the race: another caller already holds a live claim or session.
    const { data: existing } = await sb
      .from("restaurant_orders")
      .select(
        "guest_payment_session_reference, guest_payment_session_redirect_url, guest_payment_session_expires_at",
      )
      .eq("tenant_id", table.tenantId)
      .eq("id", order.id)
      .maybeSingle();
    if (
      isLiveSession(existing) &&
      !isPlaceholder(existing?.guest_payment_session_reference) &&
      existing?.guest_payment_session_redirect_url
    ) {
      return {
        ok: true,
        status: "redirect",
        redirectUrl: existing.guest_payment_session_redirect_url,
      };
    }
    return { ok: false, reason: "initiation_in_progress" };
  }

  // The provider call is bounded by the exact same deadline as the DB
  // claim, via an actual cancellation signal — not merely a bookkeeping
  // timestamp. Once this fires, this attempt's own request to the provider
  // is dead; it cannot go on to independently produce a real session after
  // a newer caller has already claimed the slot. Cleared on settle either
  // way so it never fires (harmlessly) after this call has already returned.
  const claimDeadline = new AbortController();
  const claimTimer = setTimeout(() => claimDeadline.abort(), GUEST_PAYMENT_CLAIM_TTL_MS);

  // Server-derived amount/currency/reference only — input carries nothing but tableId/orderId/method.
  let initiated: { providerReference: string; redirectUrl: string };
  try {
    initiated = await provider.initiate({
      amount: amountDue,
      currency: order.currency,
      merchantReference: order.id,
      description: `Order ${order.order_number}`,
      returnUrl,
      signal: claimDeadline.signal,
    });
  } catch (err) {
    clearTimeout(claimTimer);
    // Release the claim — but only if it's still ours. If this attempt's
    // own claim already expired and a newer caller has since claimed (or
    // completed) a session, that newer state must never be cleared by a
    // late failure arriving from this one.
    await sb
      .from("restaurant_orders")
      .update({
        guest_payment_session_reference: null,
        guest_payment_session_redirect_url: null,
        guest_payment_session_expires_at: null,
      })
      .eq("tenant_id", table.tenantId)
      .eq("id", order.id)
      .eq("guest_payment_session_reference", myClaimToken);
    throw err;
  }
  clearTimeout(claimTimer);

  // Finalize — again only if this attempt's claim is still the one on the
  // row. A late success from an expired claim must never overwrite a newer
  // claimant's already-recorded session; the real checkout session this
  // call itself created is still returned to its own caller below (it is a
  // genuine, usable Pesapal session), it is just not the one recorded as
  // this order's authoritative claim going forward.
  await sb
    .from("restaurant_orders")
    .update({
      guest_payment_session_reference: initiated.providerReference,
      guest_payment_session_redirect_url: initiated.redirectUrl,
      guest_payment_session_expires_at: new Date(
        Date.now() + GUEST_PAYMENT_SESSION_TTL_MS,
      ).toISOString(),
    })
    .eq("tenant_id", table.tenantId)
    .eq("id", order.id)
    .eq("guest_payment_session_reference", myClaimToken);

  return { ok: true, status: "redirect", redirectUrl: initiated.redirectUrl };
}

export type ConfirmGuestPaymentResult =
  | { ok: true; status: "paid"; order: Awaited<ReturnType<typeof guestOrderStatus>> }
  | { ok: true; status: "pending" }
  | { ok: false; reason: "declined" | "expired"; detail?: string }
  | { ok: false; reason: "amount_mismatch" }
  | { ok: false; reason: "already_paid" }
  | { ok: false; reason: "provider_not_configured" };

/** A cent of slack against floating-point/rounding noise — the same tolerance recalcOrder already uses for its own paid/total comparison. */
const AMOUNT_TOLERANCE = 0.01;

/**
 * The one place a Pesapal outcome is ever turned into a recorded payment —
 * called both from the guest's browser on return from checkout, and from
 * the provider's own server-to-server callback (see api/pesapal-ipn.ts).
 * Both paths do the identical thing: re-verify with the provider, reconcile
 * the amount/currency the provider actually confirms against this order's
 * own amount due, then hand off to the existing, unchanged, idempotent
 * recordGuestPayment. A "paid" status alone is never enough — the provider
 * must also confirm the right amount, in the right currency, for this
 * exact order, or nothing is recorded. A repeated call (browser refresh, a
 * replayed webhook) is safe — verify() is read-only, and
 * recordGuestPayment's client_request_id unique index (keyed on the
 * provider reference) makes the eventual insert a no-op the second time.
 */
export async function confirmGuestPayment(
  sb: Sb,
  order: { id: string; tenantId: string; currency: string; total: number; paidTotal: number },
  providerReference: string,
  provider: PaymentProviderAdapter | null = getConfiguredProvider(),
): Promise<ConfirmGuestPaymentResult> {
  const amountDue = Math.max(0, Number(order.total) - Number(order.paidTotal));
  if (amountDue <= 0) {
    return { ok: false, reason: "already_paid" };
  }
  if (!provider) {
    return { ok: false, reason: "provider_not_configured" };
  }

  const result = await provider.verify({ providerReference });
  if (result.status === "pending") {
    return { ok: true, status: "pending" };
  }
  if (result.status !== "paid") {
    return {
      ok: false,
      reason: result.status === "expired" ? "expired" : "declined",
      detail: result.failureReason,
    };
  }

  // The provider says paid — but not for whatever it says, only for what
  // this order is actually owed. A stale/reused tracking id, or a provider
  // confirming a different amount than expected, must never settle a bill
  // for less (or more) than it's actually worth.
  if (
    Math.abs(Number(result.amount) - amountDue) > AMOUNT_TOLERANCE ||
    result.currency !== order.currency
  ) {
    return { ok: false, reason: "amount_mismatch" };
  }

  await recordGuestPayment(sb, {
    tenantId: order.tenantId,
    orderId: order.id,
    method: "mobile_money",
    amount: amountDue,
    currency: order.currency,
    providerReference,
  });

  return {
    ok: true,
    status: "paid",
    order: await orderStatusByTenantAndId(sb, order.tenantId, order.id),
  };
}

/**
 * Entry point for the guest's own browser returning from Pesapal's hosted
 * checkout — table + order scoped exactly like every other guest function
 * in this module, with the provider reference read from the URL Pesapal
 * redirected to (never trusted on its own; confirmGuestPayment re-verifies
 * it below).
 */
export async function confirmGuestPaymentFromBrowser(
  sb: Sb,
  input: { tableId: string; orderId: string; orderTrackingId: string },
  provider: PaymentProviderAdapter | null = getConfiguredProvider(),
): Promise<ConfirmGuestPaymentResult> {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrder(sb, table.tenantId, input.tableId, input.orderId);
  return confirmGuestPayment(
    sb,
    {
      id: order.id,
      tenantId: table.tenantId,
      currency: order.currency,
      total: Number(order.total),
      paidTotal: Number(order.paid_total),
    },
    input.orderTrackingId,
    provider,
  );
}

/**
 * The narrow, tenant-scoped lookup a provider's own server-to-server
 * callback needs: it carries only the provider's own merchant reference
 * (this codebase's order id) and its provider reference — no table, no
 * guest context, no client-asserted identity of any kind.
 */
export async function confirmPesapalCallback(
  sb: Sb,
  input: { orderId: string; providerReference: string },
  provider: PaymentProviderAdapter | null = getConfiguredProvider(),
): Promise<ConfirmGuestPaymentResult | { ok: false; reason: "order_not_found" }> {
  const order = await loadOrderByPesapalMerchantReference(sb, input.orderId);
  if (!order) return { ok: false, reason: "order_not_found" };
  return confirmGuestPayment(
    sb,
    {
      id: order.id,
      tenantId: order.tenant_id,
      currency: order.currency,
      total: Number(order.total),
      paidTotal: Number(order.paid_total),
    },
    input.providerReference,
    provider,
  );
}
