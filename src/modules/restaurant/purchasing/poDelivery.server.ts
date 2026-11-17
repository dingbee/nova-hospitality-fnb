/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * O11 — supplier communication for purchase orders.
 *
 * One rule governs this file: the purchase order is already authorized. This
 * module never approves, creates, submits or reprices a PO — it re-reads the
 * canonical, already-governed record and attempts to hand a copy to the
 * supplier, appending an attempt row. Nothing here claims "delivered" unless
 * a provider actually confirmed it. Mirrors receipts/delivery.server.ts's
 * shape exactly, reusing the same adapters and the same idempotency pattern.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import {
  emailConfigured,
  sendEmail,
  sendWhatsApp,
  whatsappConfigured,
} from "@/lib/notifications/adapters.server";
import {
  PO_DELIVERY_FAILURE_MESSAGES,
  buildPurchaseOrderMessage,
  isValidEmail,
  normalizeEmail,
  normalizePhone,
  whatsAppShareUrl,
  type ListPoDeliveriesInput,
  type PoDeliveryFailureCode,
  type PoDeliveryMethod,
  type PoDeliveryRecord,
  type PoDeliveryStatus,
  type RequestPoDeliveryInput,
} from "./poDelivery.types";

type Sb = any;

/**
 * Only an order that has cleared the existing approval gate may be sent — a
 * `draft`/`submitted` order has not been authorized yet, and a `cancelled`
 * order never will be. `received` is fulfilled and no longer needs
 * communicating, so it is intentionally excluded too.
 */
const SENDABLE_PO_STATUSES = new Set(["approved", "partially_received"]);

export function emailProviderConfigured(): boolean {
  return emailConfigured() && process.env["EMAIL_SENDING_DISABLED"] !== "true";
}

export function whatsappProviderConfigured(): boolean {
  return whatsappConfigured();
}

export function providerStatus() {
  return { email: emailProviderConfigured(), whatsapp: whatsappProviderConfigured() };
}

function fmtMoney(amount: number, currency: string): string {
  return `${currency} ${Number(amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toRecord(row: any): PoDeliveryRecord {
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    documentNumber: row.document_number ?? null,
    method: row.method as PoDeliveryMethod,
    recipient: row.recipient ?? null,
    status: row.status as PoDeliveryStatus,
    provider: row.provider ?? null,
    providerReference: row.provider_reference ?? null,
    failureCode: (row.failure_code as PoDeliveryFailureCode) ?? null,
    failureReason: row.failure_reason ?? null,
    attempt: Number(row.attempt ?? 1),
    requestedAt: row.requested_at,
    completedAt: row.completed_at ?? null,
  };
}

async function loadPurchaseOrder(sb: Sb, tenantId: string, id: string) {
  const { data, error } = await sb
    .from("restaurant_purchase_orders")
    .select(
      "id, tenant_id, property_id, location_id, status, document_number, reference, supplier_id, currency, total, correlation_id, expected_at",
    )
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function loadSupplier(sb: Sb, tenantId: string, supplierId: string | null) {
  if (!supplierId) return null;
  const { data } = await sb
    .from("restaurant_suppliers")
    .select("id, name, email, phone, contact_name, metadata")
    .eq("tenant_id", tenantId)
    .eq("id", supplierId)
    .maybeSingle();
  return data ?? null;
}

/**
 * Requests one supplier-communication attempt for a purchase order.
 * Idempotent per (tenant, idempotencyKey): a repeat of the same key returns
 * the recorded attempt instead of sending twice. A deliberate staff retry
 * uses a new key, so failures stay in history rather than being silently
 * overwritten.
 */
export async function requestPoDelivery(
  sb: Sb,
  userId: string,
  input: RequestPoDeliveryInput,
): Promise<PoDeliveryRecord> {
  await assertCapability(sb, userId, input.tenantId, "purchasing.manage");

  const { data: existing } = await sb
    .from("restaurant_po_deliveries")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existing) return { ...toRecord(existing), duplicate: true };

  // Re-read the purchase order fresh, server-side — never trust a
  // client-supplied status, supplier or total. This is the same governed
  // record Print/Download already read from.
  const po = await loadPurchaseOrder(sb, input.tenantId, input.purchaseOrderId);
  if (!po) throw new Error("Purchase order not found.");
  if (!SENDABLE_PO_STATUSES.has(po.status)) {
    throw new Error(PO_DELIVERY_FAILURE_MESSAGES.purchase_order_not_sendable);
  }

  const supplier = await loadSupplier(sb, input.tenantId, po.supplier_id);
  if (!supplier) throw new Error(PO_DELIVERY_FAILURE_MESSAGES.supplier_missing);

  const { count } = await sb
    .from("restaurant_po_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", input.tenantId)
    .eq("purchase_order_id", po.id)
    .eq("method", input.method);

  const attempt = Number(count ?? 0) + 1;
  const recipient =
    input.recipient?.trim() || (input.method === "email" ? supplier.email : supplier.phone) || null;

  const base = {
    tenant_id: input.tenantId,
    property_id: po.property_id ?? null,
    location_id: po.location_id ?? null,
    purchase_order_id: po.id,
    document_number: po.document_number ?? po.reference ?? null,
    method: input.method,
    recipient,
    attempt,
    idempotency_key: input.idempotencyKey,
    correlation_id: input.correlationId ?? po.correlation_id ?? null,
    initiated_by: userId,
    status: "pending" as PoDeliveryStatus,
  };

  const { data: row, error } = await sb
    .from("restaurant_po_deliveries")
    .insert(base)
    .select("*")
    .single();
  if (error) {
    // Unique idempotency race — return the winning attempt.
    const { data: winner } = await sb
      .from("restaurant_po_deliveries")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (winner) return { ...toRecord(winner), duplicate: true };
    throw new Error(error.message);
  }

  await emitCommunication(sb, userId, po, input.method, "requested", { attempt });

  const outcome = await performPoDelivery(sb, userId, input.method, { po, supplier, recipient });

  const { data: settled } = await sb
    .from("restaurant_po_deliveries")
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
  await recordAudit(sb, userId, po, input.method, final);
  await emitCommunication(
    sb,
    userId,
    po,
    input.method,
    final.status === "failed" ? "failed" : final.status === "delivered" ? "delivered" : "sent",
    { attempt, status: final.status, failure_code: final.failure_code ?? null },
  );

  return toRecord(final);
}

interface Outcome {
  status: PoDeliveryStatus;
  provider?: string;
  providerReference?: string;
  failureCode?: PoDeliveryFailureCode;
  failureReason?: string;
  recipient?: string | null;
  metadata?: Record<string, unknown>;
}

async function performPoDelivery(
  sb: Sb,
  userId: string,
  method: PoDeliveryMethod,
  ctx: { po: any; supplier: any; recipient: string | null },
): Promise<Outcome> {
  const { po, supplier } = ctx;
  const currency = po.currency ?? "TZS";
  const total = fmtMoney(Number(po.total ?? 0), currency);
  const documentNumber = po.document_number ?? po.reference ?? po.id;

  if (method === "email") {
    const recipient = (ctx.recipient ?? "").trim();
    if (!isValidEmail(recipient)) {
      return {
        status: "failed",
        failureCode: "invalid_email",
        failureReason: PO_DELIVERY_FAILURE_MESSAGES.invalid_email,
      };
    }
    if (!emailProviderConfigured()) {
      return {
        status: "failed",
        failureCode: "email_provider_not_configured",
        failureReason: PO_DELIVERY_FAILURE_MESSAGES.email_provider_not_configured,
      };
    }
    const to = normalizeEmail(recipient);
    // The email body is the exact same canonical document Print/Download
    // renders — one source of commercial content, never re-derived here.
    const { renderDocument } = await import("../documents/builders/documents.server");
    const { documentToHtml } = await import("../documents/rendering/toHtml");
    const doc = await renderDocument(sb, userId, po.tenant_id, "purchase_order", po.id);
    const html = documentToHtml(doc);
    const text = buildPurchaseOrderMessage({
      documentNumber,
      supplierName: supplier?.name ?? null,
      total,
      expectedAt: po.expected_at ?? null,
    });
    const res = await sendEmail({
      to,
      subject: `Purchase Order ${documentNumber}`,
      html,
      text,
      idempotencyKey: `po-${po.id}-email-${to}-${Date.now()}`,
    });
    if (res.ok)
      return {
        status: "sent",
        provider: res.provider,
        providerReference: res.reference,
        recipient: to,
      };
    return {
      status: "failed",
      provider: res.provider,
      recipient: to,
      failureCode: res.reason === "network" ? "network_timeout" : "provider_rejected",
      failureReason: res.error ?? PO_DELIVERY_FAILURE_MESSAGES.provider_rejected,
    };
  }

  // WhatsApp
  const phone = normalizePhone(ctx.recipient);
  if (!phone) {
    return {
      status: "failed",
      failureCode: "invalid_phone",
      failureReason: PO_DELIVERY_FAILURE_MESSAGES.invalid_phone,
    };
  }
  const message = buildPurchaseOrderMessage({
    documentNumber,
    supplierName: supplier?.name ?? null,
    total,
    expectedAt: po.expected_at ?? null,
  });
  if (!whatsappProviderConfigured()) {
    // No provider: staff may still share manually. This is NOT delivery.
    return {
      status: "shared",
      provider: "manual_share",
      recipient: phone,
      metadata: { shareLink: whatsAppShareUrl(phone, message) },
      failureCode: "whatsapp_provider_not_configured",
      failureReason: PO_DELIVERY_FAILURE_MESSAGES.whatsapp_provider_not_configured,
    };
  }
  const res = await sendWhatsApp(phone, message);
  if (res.ok) {
    // The provider confirms acceptance, not receipt — "sent", never "delivered".
    return {
      status: "sent",
      provider: res.provider,
      providerReference: res.reference,
      recipient: phone,
    };
  }
  return {
    status: "failed",
    provider: res.provider,
    recipient: phone,
    failureCode: res.reason === "network" ? "network_timeout" : "provider_rejected",
    failureReason: res.error ?? PO_DELIVERY_FAILURE_MESSAGES.provider_rejected,
  };
}

async function recordAudit(sb: Sb, userId: string, po: any, method: PoDeliveryMethod, row: any) {
  try {
    const { recordDocumentEvent } = await import("../documents/audit/audit.server");
    await recordDocumentEvent(sb, userId, {
      tenantId: po.tenant_id,
      documentType: "purchase_order",
      documentId: po.id,
      documentNumber: po.document_number ?? po.reference,
      action: method === "email" ? "emailed" : "whatsapped",
      format: method === "email" ? "pdf" : "whatsapp",
      propertyId: po.property_id ?? null,
      locationId: po.location_id ?? null,
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
    console.warn("[restaurant-os] PO delivery audit failed", e);
  }
}

async function emitCommunication(
  sb: Sb,
  userId: string,
  po: any,
  method: PoDeliveryMethod,
  phase: "requested" | "sent" | "failed" | "delivered",
  payload: Record<string, unknown>,
) {
  await emitRestaurantEvent(sb, userId, {
    type: `restaurant.purchase.order.communication.${phase}` as any,
    tenantId: po.tenant_id,
    propertyId: po.property_id ?? undefined,
    locationId: po.location_id ?? undefined,
    entityType: "restaurant_purchase_order",
    entityId: po.id,
    source: "restaurant-os",
    correlationId: po.correlation_id ?? undefined,
    payload: { document_number: po.document_number ?? po.reference ?? null, method, ...payload },
  });
}

export async function listPoDeliveries(sb: Sb, userId: string, input: ListPoDeliveriesInput) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_po_deliveries")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("requested_at", { ascending: false })
    .limit(input.limit);
  if (input.purchaseOrderId) q = q.eq("purchase_order_id", input.purchaseOrderId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as any[]).map((r) => toRecord(r));
}
