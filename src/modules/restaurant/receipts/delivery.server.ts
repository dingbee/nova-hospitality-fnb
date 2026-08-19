/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Receipt delivery control layer.
 *
 * One rule governs this file: the receipt is already final. Delivery reads the
 * immutable snapshot, attempts to hand a copy to the guest, and appends an
 * attempt row. Nothing here recomputes money, and nothing claims "delivered"
 * unless a provider actually confirmed it.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { resolvePublicOrigin } from "../core/product";
import { getRequestHeader } from "@tanstack/react-start/server";
import { emitRestaurantEvent } from "../events/emit.server";
import {
  emailConfigured,
  renderReceiptEmail,
  sendEmail,
  sendWhatsApp,
  whatsappConfigured,
} from "@/lib/notifications/adapters.server";
import {
  DELIVERY_FAILURE_MESSAGES,
  buildReceiptMessage,
  isValidEmail,
  normalizeEmail,
  normalizePhone,
  whatsAppShareUrl,
  type DeliveryFailureCode,
  type DeliveryMethod,
  type DeliveryRecord,
  type DeliveryStatus,
  type ListDeliveriesInput,
  type RequestDeliveryInput,
} from "./delivery.types";

type Sb = any;

const SHARE_TTL_DAYS = 30;

function siteOrigin(): string {
  // No customer domain is baked into the product: deployment config first,
  // then the live request host, then a relative link.
  try {
    return resolvePublicOrigin(getRequestHeader("host"), getRequestHeader("x-forwarded-proto") ?? "https");
  } catch {
    return resolvePublicOrigin(null);
  }
}

export function emailProviderConfigured(): boolean {
  // Each deployment brings its own relay; nothing is assumed to exist.
  return emailConfigured() && process.env["EMAIL_SENDING_DISABLED"] !== "true";
}

export function whatsappProviderConfigured(): boolean {
  return whatsappConfigured();
}

export function providerStatus() {
  return { email: emailProviderConfigured(), whatsapp: whatsappProviderConfigured() };
}

function token(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fmtMoney(amount: number, currency: string): string {
  return `${currency} ${Number(amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toRecord(row: any, origin = siteOrigin()): DeliveryRecord {
  return {
    id: row.id,
    receiptId: row.receipt_id,
    receiptNumber: row.receipt_number ?? null,
    method: row.method as DeliveryMethod,
    recipient: row.recipient ?? null,
    status: row.status as DeliveryStatus,
    provider: row.provider ?? null,
    providerReference: row.provider_reference ?? null,
    failureCode: (row.failure_code as DeliveryFailureCode) ?? null,
    failureReason: row.failure_reason ?? null,
    attempt: Number(row.attempt ?? 1),
    requestedAt: row.requested_at,
    completedAt: row.completed_at ?? null,
    shareUrl: row.share_token ? `${origin}/receipt/${row.share_token}` : null,
  };
}

async function loadReceipt(sb: Sb, tenantId: string, input: RequestDeliveryInput) {
  let q = sb.from("restaurant_receipts").select("*").eq("tenant_id", tenantId);
  q = input.receiptId ? q.eq("id", input.receiptId) : q.eq("order_id", input.orderId);
  const { data } = await q.maybeSingle();
  return data ?? null;
}

/**
 * Requests one delivery attempt. Idempotent per (tenant, idempotencyKey):
 * a repeat of the same key returns the recorded attempt instead of sending
 * twice. A deliberate staff retry uses a new key, so failures stay in history.
 */
export async function requestDelivery(
  sb: Sb,
  userId: string,
  input: RequestDeliveryInput,
): Promise<DeliveryRecord> {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");
  if (!input.receiptId && !input.orderId) throw new Error("A receipt or order must be given.");

  const { data: existing } = await sb
    .from("restaurant_receipt_deliveries")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existing) return { ...toRecord(existing), duplicate: true };

  const receipt = await loadReceipt(sb, input.tenantId, input);
  if (!receipt) throw new Error(DELIVERY_FAILURE_MESSAGES.receipt_unavailable);

  const { count } = await sb
    .from("restaurant_receipt_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", input.tenantId)
    .eq("receipt_id", receipt.id)
    .eq("method", input.method);

  const attempt = Number(count ?? 0) + 1;
  const origin = siteOrigin();
  const needsLink = input.method !== "print";
  const shareToken = needsLink ? token() : null;
  const shareUrl = shareToken ? `${origin}/receipt/${shareToken}` : null;
  const expiresAt = shareToken ? new Date(Date.now() + SHARE_TTL_DAYS * 864e5).toISOString() : null;

  const base = {
    tenant_id: input.tenantId,
    property_id: receipt.property_id ?? null,
    location_id: receipt.location_id ?? null,
    receipt_id: receipt.id,
    order_id: receipt.order_id,
    receipt_number: receipt.receipt_number,
    method: input.method,
    recipient: input.recipient?.trim() || null,
    attempt,
    idempotency_key: input.idempotencyKey,
    share_token: shareToken,
    share_expires_at: expiresAt,
    correlation_id: input.correlationId ?? null,
    initiated_by: userId,
    status: "pending" as DeliveryStatus,
  };

  const { data: row, error } = await sb
    .from("restaurant_receipt_deliveries")
    .insert(base)
    .select("*")
    .single();
  if (error) {
    // Unique idempotency race — return the winning attempt.
    const { data: winner } = await sb
      .from("restaurant_receipt_deliveries")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (winner) return { ...toRecord(winner), duplicate: true };
    throw new Error(error.message);
  }

  await emitDelivery(sb, userId, receipt, input.method, "requested", { attempt });

  const outcome = await performDelivery(input.method, {
    receipt,
    recipient: base.recipient,
    shareUrl,
  });

  const { data: settled } = await sb
    .from("restaurant_receipt_deliveries")
    .update({
      status: outcome.status,
      provider: outcome.provider ?? null,
      provider_reference: outcome.providerReference ?? null,
      failure_code: outcome.failureCode ?? null,
      failure_reason: outcome.failureReason ?? null,
      recipient: outcome.recipient ?? base.recipient,
      completed_at: new Date().toISOString(),
      metadata: outcome.metadata ?? {},
    })
    .eq("id", row.id)
    .select("*")
    .single();

  const final = settled ?? row;
  await recordAudit(sb, userId, receipt, input.method, final);
  await emitDelivery(
    sb,
    userId,
    receipt,
    input.method,
    final.status === "failed" ? "failed" : final.status === "delivered" ? "delivered" : "sent",
    { attempt, status: final.status, failure_code: final.failure_code ?? null },
  );

  // Keep the receipt's "last delivery" fields in step, without touching money.
  if (final.status === "sent" || final.status === "delivered") {
    await sb
      .from("restaurant_receipts")
      .update({
        delivery_channel: input.method,
        delivered_to: final.recipient,
        delivered_at: new Date().toISOString(),
      })
      .eq("id", receipt.id);
  }

  return toRecord(final, origin);
}

interface Outcome {
  status: DeliveryStatus;
  provider?: string;
  providerReference?: string;
  failureCode?: DeliveryFailureCode;
  failureReason?: string;
  recipient?: string | null;
  metadata?: Record<string, unknown>;
}

async function performDelivery(
  method: DeliveryMethod,
  ctx: { receipt: any; recipient: string | null; shareUrl: string | null },
): Promise<Outcome> {
  const { receipt, shareUrl } = ctx;
  const currency = receipt.currency ?? "TZS";
  const total = fmtMoney(Number(receipt.total ?? 0), currency);
  const outlet = receipt.snapshot?.order?.outlet ?? null;

  if (method === "print") return { status: "sent", provider: "local_printer" };
  if (method === "secure_link") return { status: "sent", provider: "secure_link", metadata: { shareUrl } };

  if (method === "email") {
    const recipient = (ctx.recipient ?? "").trim();
    if (!isValidEmail(recipient)) {
      return { status: "failed", failureCode: "invalid_email", failureReason: DELIVERY_FAILURE_MESSAGES.invalid_email };
    }
    if (!emailProviderConfigured()) {
      return {
        status: "failed",
        failureCode: "email_provider_not_configured",
        failureReason: DELIVERY_FAILURE_MESSAGES.email_provider_not_configured,
      };
    }
    const to = normalizeEmail(recipient);
    const rendered = renderReceiptEmail({
      receiptNumber: receipt.receipt_number,
      outlet,
      issuedAt: receipt.issued_at,
      total,
      paid: fmtMoney(Number(receipt.paid_total ?? 0), currency),
      paymentStatus: Number(receipt.paid_total ?? 0) >= Number(receipt.total ?? 0) ? "Paid in full" : "Part paid",
      lines: (receipt.snapshot?.lines ?? []).map((l: any) => ({
        description: l.description,
        quantity: Number(l.quantity ?? 0),
        amount: fmtMoney(Number(l.line_total ?? 0), currency),
      })),
      receiptUrl: shareUrl ?? "",
    });
    const res = await sendEmail({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: `receipt-${receipt.id}-${to}-${Date.now()}`,
    });
    if (res.ok) return { status: "sent", provider: res.provider, providerReference: res.reference, recipient: to };
    return {
      status: "failed",
      provider: res.provider,
      recipient: to,
      failureCode: res.reason === "network" ? "network_timeout" : "provider_rejected",
      failureReason: res.error ?? DELIVERY_FAILURE_MESSAGES.provider_rejected,
    };
  }

  // WhatsApp
  const phone = normalizePhone(ctx.recipient);
  if (!phone) {
    return { status: "failed", failureCode: "invalid_phone", failureReason: DELIVERY_FAILURE_MESSAGES.invalid_phone };
  }
  const message = buildReceiptMessage({
    receiptNumber: receipt.receipt_number,
    outlet,
    total,
    issuedAt: receipt.issued_at,
    link: shareUrl,
  });
  if (!whatsappProviderConfigured()) {
    // No provider: staff may still share manually. This is NOT delivery.
    return {
      status: "shared",
      provider: "manual_share",
      recipient: phone,
      metadata: { shareUrl, shareLink: whatsAppShareUrl(phone, message) },
      failureCode: "whatsapp_provider_not_configured",
      failureReason: DELIVERY_FAILURE_MESSAGES.whatsapp_provider_not_configured,
    };
  }
  const res = await sendWhatsApp(phone, message);
  if (res.ok) {
    // The provider confirms acceptance, not receipt — "sent", never "delivered".
    return { status: "sent", provider: res.provider, providerReference: res.reference, recipient: phone };
  }
  return {
    status: "failed",
    provider: res.provider,
    recipient: phone,
    failureCode: res.reason === "network" ? "network_timeout" : "provider_rejected",
    failureReason: res.error ?? DELIVERY_FAILURE_MESSAGES.provider_rejected,
  };
}

async function recordAudit(sb: Sb, userId: string, receipt: any, method: DeliveryMethod, row: any) {
  try {
    const { recordDocumentEvent } = await import("../documents/audit/audit.server");
    await recordDocumentEvent(sb, userId, {
      tenantId: receipt.tenant_id,
      documentType: "customer_receipt",
      documentId: receipt.id,
      documentNumber: receipt.receipt_number,
      action: method === "print" ? "printed" : "emailed",
      format: method === "print" ? "print" : "pdf",
      propertyId: receipt.property_id ?? null,
      locationId: receipt.location_id ?? null,
      metadata: {
        delivery_id: row.id,
        method,
        status: row.status,
        recipient: row.recipient,
        attempt: row.attempt,
        provider_reference: row.provider_reference ?? null,
      },
    });
  } catch (e) {
    console.warn("[restaurant-os] delivery audit failed", e);
  }
}

async function emitDelivery(
  sb: Sb,
  userId: string,
  receipt: any,
  method: DeliveryMethod,
  phase: "requested" | "sent" | "failed" | "delivered",
  payload: Record<string, unknown>,
) {
  await emitRestaurantEvent(sb, userId, {
    type: `restaurant.receipt.delivery.${phase}` as any,
    tenantId: receipt.tenant_id,
    propertyId: receipt.property_id ?? undefined,
    locationId: receipt.location_id ?? undefined,
    entityType: "restaurant_receipt",
    entityId: receipt.id,
    source: "restaurant-pos",
    payload: { receipt_number: receipt.receipt_number, method, ...payload },
  });
}

export async function listDeliveries(sb: Sb, userId: string, input: ListDeliveriesInput) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_receipt_deliveries")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("requested_at", { ascending: false })
    .limit(input.limit);
  if (input.receiptId) q = q.eq("receipt_id", input.receiptId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as any[]).map((r) => toRecord(r));
}

/**
 * Public, token-scoped read of an already-issued receipt. The token is the
 * only credential; it is unguessable, expiring, and bound to one receipt, so
 * no tenant can reach another tenant's document through it.
 */
export async function getSharedReceipt(tokenValue: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: delivery } = await supabaseAdmin
    .from("restaurant_receipt_deliveries")
    .select("receipt_id, share_expires_at")
    .eq("share_token", tokenValue)
    .maybeSingle();
  if (!delivery) return { ok: false as const, reason: "not_found" as const };
  if (delivery.share_expires_at && new Date(delivery.share_expires_at).getTime() < Date.now()) {
    return { ok: false as const, reason: "expired" as const };
  }
  const { data: receipt } = await supabaseAdmin
    .from("restaurant_receipts")
    .select("receipt_number, currency, subtotal, discount_total, tax_total, service_charge, total, paid_total, issued_at, snapshot")
    .eq("id", delivery.receipt_id)
    .maybeSingle();
  if (!receipt) return { ok: false as const, reason: "not_found" as const };
  const snapshot: any = receipt.snapshot ?? {};
  return {
    ok: true as const,
    receipt: {
      number: receipt.receipt_number,
      currency: receipt.currency,
      subtotal: Number(receipt.subtotal ?? 0),
      discountTotal: Number(receipt.discount_total ?? 0),
      taxTotal: Number(receipt.tax_total ?? 0),
      serviceCharge: Number(receipt.service_charge ?? 0),
      total: Number(receipt.total ?? 0),
      paid: Number(receipt.paid_total ?? 0),
      issuedAt: receipt.issued_at,
      lines: (snapshot.lines ?? []).map((l: any) => ({
        description: l.description,
        quantity: Number(l.quantity ?? 0),
        amount: Number(l.line_total ?? 0),
      })),
      payments: (snapshot.payments ?? []).map((p: any) => ({
        method: String(p.method ?? ""),
        amount: Number(p.amount ?? 0),
      })),
    },
  };
}