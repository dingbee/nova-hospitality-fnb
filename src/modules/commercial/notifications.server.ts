/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P02 §36 — commercial notifications. Reuses the SAME send path every other
 * notification in this codebase uses (`src/lib/notifications/adapters.server.ts`'s
 * `sendEmail`) — this module only decides WHEN to send and records the
 * attempt, mirroring `restaurant_po_deliveries`' idempotent-attempt shape.
 * Never a second delivery mechanism.
 */
import { emailConfigured, sendEmail } from "@/lib/notifications/adapters.server";

type Sb = any;

export interface CommercialNotificationInput {
  tenantId: string;
  eventType: string;
  entityType: string;
  entityId?: string | null;
  idempotencyKey: string;
  subject: string;
  body: string;
  /** Full HTML body (e.g. a rendered invoice document) — falls back to a plain wrapped paragraph of `body` when omitted. */
  html?: string;
}

async function billingRecipient(sb: Sb, tenantId: string): Promise<string | null> {
  const { data } = await sb
    .from("commercial_billing_accounts")
    .select("billing_contact_email")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (data?.billing_contact_email) return data.billing_contact_email;
  const { data: tenant } = await sb
    .from("restaurant_tenants")
    .select("settings")
    .eq("id", tenantId)
    .maybeSingle();
  const business =
    (tenant?.settings as { business?: Record<string, unknown> } | null)?.business ?? {};
  const email = business.email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

/**
 * Best-effort, idempotent per (tenant, idempotencyKey) — a repeat call
 * (e.g. a retried invoice-issue request) returns the already-recorded
 * attempt instead of sending a duplicate email. Never throws: a
 * notification failure must not roll back the commercial action that
 * triggered it (mirrors poDelivery.server.ts's own non-blocking discipline).
 */
export async function sendCommercialNotification(
  sb: Sb,
  input: CommercialNotificationInput,
): Promise<void> {
  const { data: existing } = await sb
    .from("commercial_notifications")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existing) return;

  const recipient = await billingRecipient(sb, input.tenantId);
  const base = {
    tenant_id: input.tenantId,
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    channel: "email" as const,
    recipient,
    idempotency_key: input.idempotencyKey,
  };

  if (!recipient) {
    await sb.from("commercial_notifications").insert({
      ...base,
      status: "not_configured",
      failure_reason: "No billing contact email configured for this tenant.",
    });
    return;
  }
  if (!emailConfigured()) {
    await sb.from("commercial_notifications").insert({
      ...base,
      status: "not_configured",
      failure_reason: "Email provider not configured.",
    });
    return;
  }

  try {
    const res = await sendEmail({
      to: recipient,
      subject: input.subject,
      html:
        input.html ??
        `<!doctype html><html><body style="font-family:system-ui,sans-serif"><p>${escapeHtml(input.body)}</p></body></html>`,
      text: input.body,
      idempotencyKey: input.idempotencyKey,
    });
    await sb.from("commercial_notifications").insert({
      ...base,
      status: res.ok ? "sent" : "failed",
      provider_reference: res.ok ? res.reference : null,
      failure_reason: res.ok ? null : (res.error ?? res.reason),
    });
  } catch (e) {
    await sb
      .from("commercial_notifications")
      .insert({ ...base, status: "failed", failure_reason: (e as Error).message });
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export async function listCommercialNotifications(sb: Sb, filter: { tenantId?: string }) {
  let q = sb
    .from("commercial_notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}
