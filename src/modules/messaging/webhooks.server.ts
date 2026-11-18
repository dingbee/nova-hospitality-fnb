/* eslint-disable @typescript-eslint/no-explicit-any -- Meta webhook payload is validated at the trust boundary. */
import { createHash } from "node:crypto";
import { verifyWebhookSignature } from "./providers/meta-cloud-api.server";

type SupabaseAdmin = any;

export class MetaWebhookSignatureError extends Error {
  constructor() {
    super("Meta webhook signature verification failed.");
    this.name = "MetaWebhookSignatureError";
  }
}

export class MetaWebhookPersistenceError extends Error {
  constructor() {
    super("Meta webhook event could not be durably persisted.");
    this.name = "MetaWebhookPersistenceError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function providerTimestamp(value: Record<string, any>): string | null {
  const candidate =
    value.messages?.[0]?.timestamp ??
    value.statuses?.[0]?.timestamp ??
    value.message_template_status_update?.[0]?.timestamp;
  if (typeof candidate !== "string" || !/^\d{9,12}$/.test(candidate)) return null;
  const date = new Date(Number(candidate) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Verify the raw webhook body and persist each phone-scoped change into the
 * durable inbox. This function does not process messages or execute commerce.
 */
export async function ingestMetaWhatsAppWebhook(
  admin: SupabaseAdmin,
  rawBody: string,
  signature: string | null,
  appSecret: string,
) {
  if (Buffer.byteLength(rawBody, "utf8") > 262_144) {
    throw new MetaWebhookPersistenceError();
  }
  if (!signature || !verifyWebhookSignature(rawBody, signature, appSecret)) {
    throw new MetaWebhookSignatureError();
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new MetaWebhookPersistenceError();
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  if (entries.length === 0) return { accepted: 0, duplicates: 0, rejected: 0, ignored: 1 };

  const bodyHash = sha256(rawBody);
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;
  let ignored = 0;

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    const wabaId = typeof entry?.id === "string" ? entry.id : null;
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
      const change = changes[changeIndex];
      const value = typeof change?.value === "object" && change.value !== null ? change.value : {};
      const phoneNumberId =
        typeof value.metadata?.phone_number_id === "string" ? value.metadata.phone_number_id : null;
      const eventType = typeof change?.field === "string" ? change.field : "unknown";

      if (
        !phoneNumberId ||
        !wabaId ||
        !/^\d{3,32}$/.test(phoneNumberId) ||
        !/^\d{3,32}$/.test(wabaId)
      ) {
        ignored += 1;
        continue;
      }

      const eventKey = sha256(`${bodyHash}:${entryIndex}:${changeIndex}`);
      const { data: binding, error: bindingError } = await admin
        .from("wa_phone_number_bindings")
        .select(
          "id, tenant_id, property_id, location_id, integration_id, waba_id, phone_number_id, status",
        )
        .eq("phone_number_id", phoneNumberId)
        .maybeSingle();
      if (bindingError) throw new MetaWebhookPersistenceError();

      let resolvedBinding = null;
      if (
        binding &&
        binding.status === "active" &&
        binding.waba_id === wabaId &&
        binding.phone_number_id === phoneNumberId
      ) {
        const { data: integration, error: integrationError } = await admin
          .from("api_integrations")
          .select("id, status, provider, channel_key, integration_type")
          .eq("id", binding.integration_id)
          .eq("tenant_id", binding.tenant_id)
          .eq("property_id", binding.property_id)
          .maybeSingle();
        if (integrationError) throw new MetaWebhookPersistenceError();
        if (
          integration?.status === "active" &&
          integration.provider === "meta-whatsapp" &&
          integration.channel_key === "whatsapp" &&
          integration.integration_type === "channel"
        ) {
          resolvedBinding = binding;
        }
      }

      const row = {
        binding_id: resolvedBinding?.id ?? null,
        tenant_id: resolvedBinding?.tenant_id ?? null,
        property_id: resolvedBinding?.property_id ?? null,
        location_id: resolvedBinding?.location_id ?? null,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        event_key: eventKey,
        event_type: eventType,
        provider_timestamp: providerTimestamp(value),
        body_sha256: bodyHash,
        signature_verified: true,
        payload: { wabaId, field: eventType, value },
        status: resolvedBinding ? "pending" : "rejected",
        last_error: resolvedBinding ? null : "unmapped_or_inactive_receiving_number",
      };

      const { error: insertError } = await admin.from("wa_webhook_events").insert(row);
      if (insertError?.code === "23505") {
        duplicates += 1;
        continue;
      }
      if (insertError) throw new MetaWebhookPersistenceError();
      if (resolvedBinding) accepted += 1;
      else rejected += 1;
    }
  }

  return { accepted, duplicates, rejected, ignored };
}
