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
 */
import { recordGuestPayment } from "../sales/pos.server";
import { resolveGuestTableContext } from "./selforder.server";
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

/** Redacted order/bill status for the self-order confirmation screen — order number, totals, payment state, nothing internal. */
export async function guestOrderStatus(sb: Sb, input: { tableId: string; orderId: string }) {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrder(sb, table.tenantId, input.tableId, input.orderId);
  const amountDue = Math.max(0, Number(order.total) - Number(order.paid_total));
  return {
    orderNumber: order.order_number,
    status: order.status,
    paymentState: order.payment_state,
    total: Number(order.total),
    paidTotal: Number(order.paid_total),
    amountDue,
    currency: order.currency,
  };
}

/**
 * A real, callable payment provider. Nothing in this codebase implements
 * one today — see getConfiguredProvider. Kept as an interface so a real
 * adapter (Pesapal, a card gateway, ...) is the only thing a future
 * integration needs to supply; none of the authorization, amount-derivation
 * or idempotency logic below changes.
 */
export type PaymentProviderAdapter = {
  name: string;
  charge(input: {
    amount: number;
    currency: string;
    reference: string;
  }): Promise<{ providerReference: string; status: "paid" | "failed"; failureReason?: string }>;
};

/**
 * No payment provider is configured in this deployment (no PESAPAL_*,
 * STRIPE_*, or equivalent credentials exist anywhere in this repo's
 * environment — confirmed by inspection, not assumed). This always returns
 * null until a real adapter and real credentials exist; nothing here
 * fabricates one.
 */
export function getConfiguredProvider(): PaymentProviderAdapter | null {
  return null;
}

export type InitiateGuestPaymentResult =
  | { ok: true; status: "paid"; order: Awaited<ReturnType<typeof guestOrderStatus>> }
  | { ok: false; reason: "already_paid" }
  | { ok: false; reason: "not_payable"; orderStatus: string }
  | { ok: false; reason: "provider_not_configured" }
  | { ok: false; reason: "provider_declined"; detail?: string };

export async function initiateGuestPayment(
  sb: Sb,
  input: InitiateGuestPaymentInput,
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

  // Server-derived amount/currency only — input carries nothing but tableId/orderId/method.
  const result = await provider.charge({
    amount: amountDue,
    currency: order.currency,
    reference: order.order_number,
  });

  if (result.status !== "paid") {
    return { ok: false, reason: "provider_declined", detail: result.failureReason };
  }

  await recordGuestPayment(sb, {
    tenantId: table.tenantId,
    orderId: order.id,
    method: input.method,
    amount: amountDue,
    currency: order.currency,
    providerReference: result.providerReference,
  });

  return { ok: true, status: "paid", order: await guestOrderStatus(sb, input) };
}
