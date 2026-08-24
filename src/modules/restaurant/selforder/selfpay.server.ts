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

const PAYABLE_ORDER_STATUSES = new Set(["open", "sent", "served"]);

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
   */
  initiate(input: {
    amount: number;
    currency: string;
    merchantReference: string;
    description: string;
    returnUrl: string;
  }): Promise<{ providerReference: string; redirectUrl: string }>;
  /**
   * The only source of truth for "did this actually get paid" — always
   * re-queried from the provider, never inferred from a redirect or a
   * webhook payload's own claimed status.
   */
  verify(input: {
    providerReference: string;
  }): Promise<{ status: "paid" | "failed" | "pending" | "expired"; failureReason?: string }>;
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
  | { ok: false; reason: "provider_not_configured" };

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

  // Server-derived amount/currency/reference only — input carries nothing but tableId/orderId/method.
  const { redirectUrl } = await provider.initiate({
    amount: amountDue,
    currency: order.currency,
    merchantReference: order.id,
    description: `Order ${order.order_number}`,
    returnUrl,
  });
  return { ok: true, status: "redirect", redirectUrl };
}

export type ConfirmGuestPaymentResult =
  | { ok: true; status: "paid"; order: Awaited<ReturnType<typeof guestOrderStatus>> }
  | { ok: true; status: "pending" }
  | { ok: false; reason: "declined" | "expired"; detail?: string }
  | { ok: false; reason: "already_paid" }
  | { ok: false; reason: "provider_not_configured" };

/**
 * The one place a Pesapal outcome is ever turned into a recorded payment —
 * called both from the guest's browser on return from checkout, and from
 * the provider's own server-to-server callback (see selfpay.functions.ts).
 * Both paths do the identical thing: re-verify with the provider, then
 * hand off to the existing, unchanged, idempotent recordGuestPayment. A
 * repeated call (browser refresh, a replayed webhook) is safe — verify()
 * is read-only, and recordGuestPayment's client_request_id unique index
 * (keyed on the provider reference) makes the eventual insert a no-op the
 * second time.
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
