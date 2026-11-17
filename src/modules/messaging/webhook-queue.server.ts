/* eslint-disable @typescript-eslint/no-explicit-any -- webhook JSON and privileged Supabase rows are validated at the boundary. */
import { randomUUID } from "node:crypto";
import { assertCapability } from "@/modules/restaurant/core/access.server";
import { writeCommercialAudit } from "@/modules/commercial/audit.server";
import { handleWhatsAppGuestCommerceMessage } from "./guest-commerce.server";
import { upsertWhatsAppGuestCustomer } from "./guest-crm.server";

type Db = any;
type ClaimedEvent = {
  id: string;
  tenant_id: string | null;
  property_id: string | null;
  location_id: string | null;
  binding_id: string | null;
  phone_number_id: string;
  event_type: string;
  payload: Record<string, any>;
  attempt_count: number;
  max_attempts: number;
};

function timestamp(value: unknown): string {
  if (typeof value === "string" && /^\d{9,12}$/.test(value)) {
    const parsed = new Date(Number(value) * 1000);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function messageType(value: unknown): string {
  return [
    "text",
    "image",
    "audio",
    "video",
    "document",
    "location",
    "interactive",
    "template",
  ].includes(String(value))
    ? String(value)
    : "unknown";
}

function messageContent(message: Record<string, any>): string | null {
  if (typeof message.text?.body === "string") return message.text.body;
  if (typeof message.interactive?.button_reply?.title === "string") {
    return message.interactive.button_reply.title;
  }
  if (typeof message.interactive?.list_reply?.title === "string") {
    return message.interactive.list_reply.title;
  }
  return null;
}

async function getOrCreateConversation(db: Db, event: ClaimedEvent, waUserId: string, at: string) {
  const { data: existing, error: lookupError } = await db
    .from("wa_conversations")
    .select("id, status, last_message_at")
    .eq("binding_id", event.binding_id)
    .eq("wa_user_id", waUserId)
    .in("status", ["open", "human_handoff"])
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupError) throw new Error("conversation_lookup_failed");
  if (existing) return existing;

  const { data: created, error: createError } = await db
    .from("wa_conversations")
    .insert({
      tenant_id: event.tenant_id,
      property_id: event.property_id,
      location_id: event.location_id,
      binding_id: event.binding_id,
      wa_user_id: waUserId,
      status: "open",
      last_message_at: at,
    })
    .select("id, status, last_message_at")
    .single();
  if (!createError && created) return created;
  if (createError?.code === "23505") {
    const { data: raced } = await db
      .from("wa_conversations")
      .select("id, status, last_message_at")
      .eq("binding_id", event.binding_id)
      .eq("wa_user_id", waUserId)
      .eq("status", "open")
      .maybeSingle();
    if (raced) return raced;
  }
  throw new Error("conversation_create_failed");
}

async function processMessages(db: Db, event: ClaimedEvent, value: Record<string, any>) {
  if (!event.binding_id || !event.tenant_id || !event.property_id || !event.location_id) {
    throw new Error("webhook_event_scope_missing");
  }
  const commerceEvent = {
    id: event.id,
    tenant_id: event.tenant_id,
    property_id: event.property_id,
    location_id: event.location_id,
    binding_id: event.binding_id,
  };
  const messages = Array.isArray(value.messages) ? value.messages : [];
  for (const message of messages) {
    const waUserId = typeof message.from === "string" ? message.from : "";
    const providerMessageId = typeof message.id === "string" ? message.id : "";
    if (!/^\d{8,15}$/.test(waUserId) || !providerMessageId) {
      throw new Error("inbound_message_identity_invalid");
    }

    const at = timestamp(message.timestamp);
    const conversation = await getOrCreateConversation(db, event, waUserId, at);
    const { error: insertError } = await db.from("wa_messages").insert({
      tenant_id: event.tenant_id,
      property_id: event.property_id,
      location_id: event.location_id,
      conversation_id: conversation.id,
      provider_message_id: providerMessageId,
      direction: "inbound",
      message_type: messageType(message.type),
      status: "received",
      content: messageContent(message),
      payload: message,
      provider_timestamp: at,
    });
    if (insertError && insertError.code !== "23505") {
      throw new Error("inbound_message_persistence_failed");
    }
    // Identity upsert is idempotent and also runs on provider retries; the
    // consent ledger and order history remain tenant-scoped.
    const contact = (Array.isArray(value.contacts) ? value.contacts : []).find(
      (candidate: Record<string, any>) => candidate.wa_id === waUserId,
    );
    const guestCustomer = await upsertWhatsAppGuestCustomer(db, {
      tenantId: event.tenant_id,
      propertyId: event.property_id,
      phone: waUserId,
      displayName: typeof contact?.profile?.name === "string" ? contact.profile.name : null,
      messageText: messageContent(message),
    });
    const { error: customerLinkError } = await db
      .from("wa_conversations")
      .update({ guest_customer_id: guestCustomer.id })
      .eq("id", conversation.id)
      .eq("tenant_id", event.tenant_id)
      .eq("property_id", event.property_id)
      .eq("location_id", event.location_id);
    if (customerLinkError) throw new Error("whatsapp_guest_customer_link_failed");

    // A repeated Meta delivery may re-enter this handler, but its outbox
    // request key is unique to the provider message ID.
    await handleWhatsAppGuestCommerceMessage(db, commerceEvent, conversation.id, message);

    if (!conversation.last_message_at || new Date(at) > new Date(conversation.last_message_at)) {
      const { error: updateError } = await db
        .from("wa_conversations")
        .update({ last_message_at: at, updated_at: new Date().toISOString() })
        .eq("id", conversation.id)
        .eq("tenant_id", event.tenant_id)
        .eq("property_id", event.property_id);
      if (updateError) throw new Error("conversation_activity_update_failed");
    }
  }
}

async function processStatuses(db: Db, value: Record<string, any>) {
  const statuses = Array.isArray(value.statuses) ? value.statuses : [];
  for (const status of statuses) {
    if (typeof status.id !== "string" || typeof status.status !== "string") {
      throw new Error("delivery_status_invalid");
    }
    const errors = Array.isArray(status.errors) ? status.errors : [];
    const errorCode = errors[0]?.code === undefined ? null : String(errors[0].code);
    const { data, error } = await db.rpc("wa_apply_message_delivery_status", {
      _provider_message_id: status.id,
      _status: status.status,
      _occurred_at: timestamp(status.timestamp),
      _error_code: errorCode,
    });
    if (error || data !== true) {
      throw new Error("delivery_status_message_not_found");
    }
  }
}

async function processEvent(db: Db, event: ClaimedEvent) {
  if (!event.binding_id || !event.tenant_id || !event.property_id || !event.location_id) {
    throw new Error("webhook_event_scope_missing");
  }
  const value =
    typeof event.payload?.value === "object" && event.payload.value !== null
      ? event.payload.value
      : {};
  if (event.event_type === "messages") {
    await processMessages(db, event, value);
    await processStatuses(db, value);
  }
  // Other Meta account/template notifications are durably acknowledged here;
  // their domain-specific handling is added by WCE-07.
}

async function completeEvent(db: Db, eventId: string, workerId: string) {
  const { error } = await db
    .from("wa_webhook_events")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    .eq("id", eventId)
    .eq("status", "processing")
    .eq("locked_by", workerId);
  if (error) throw new Error("webhook_event_completion_failed");
}

async function failEvent(db: Db, event: ClaimedEvent, workerId: string) {
  const deadLetter = event.attempt_count >= event.max_attempts;
  const delaySeconds = Math.min(3600, 5 * 2 ** Math.min(event.attempt_count - 1, 10));
  const { error } = await db
    .from("wa_webhook_events")
    .update({
      status: deadLetter ? "dead_letter" : "retry",
      next_attempt_at: deadLetter
        ? new Date().toISOString()
        : new Date(Date.now() + delaySeconds * 1000).toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: "event_processing_failed",
    })
    .eq("id", event.id)
    .eq("status", "processing")
    .eq("locked_by", workerId);
  if (error) throw new Error("webhook_event_retry_state_failed");
  return deadLetter;
}

/** Claim and process durable events in receiving-number order. */
export async function processPendingMetaWebhookEvents(
  db: Db,
  options: { limit?: number; workerId?: string } = {},
) {
  const workerId = options.workerId ?? randomUUID();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const { data, error } = await db.rpc("wa_claim_webhook_events", {
    _limit: limit,
    _lease_seconds: 90,
    _worker_id: workerId,
  });
  if (error) throw new Error("webhook_event_claim_failed");

  const events = Array.isArray(data) ? (data as ClaimedEvent[]) : [];
  let processed = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const event of events) {
    try {
      await processEvent(db, event);
      await completeEvent(db, event.id, workerId);
      processed += 1;
    } catch {
      const dead = await failEvent(db, event, workerId);
      if (dead) deadLettered += 1;
      else retried += 1;
    }
  }

  return { claimed: events.length, processed, retried, deadLettered };
}

/** Requeue a dead-letter event only after the caller has authorized its tenant/property. */
export async function requeueMetaWebhookDeadLetter(
  admin: Db,
  userDb: Db,
  userId: string,
  eventId: string,
) {
  const { data: event, error: lookupError } = await admin
    .from("wa_webhook_events")
    .select("id, tenant_id, property_id, status")
    .eq("id", eventId)
    .maybeSingle();
  if (
    lookupError ||
    !event ||
    event.status !== "dead_letter" ||
    !event.tenant_id ||
    !event.property_id
  ) {
    throw new Error("Dead-letter event is unavailable for requeue.");
  }

  await assertCapability(userDb, userId, event.tenant_id, "tenant.manage", {
    propertyId: event.property_id,
  });
  const { error } = await admin
    .from("wa_webhook_events")
    .update({
      status: "pending",
      attempt_count: 0,
      next_attempt_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
      processed_at: null,
    })
    .eq("id", eventId)
    .eq("status", "dead_letter");
  if (error) throw new Error("Dead-letter event could not be requeued.");
  await writeCommercialAudit(userDb, {
    actorId: userId,
    action: "whatsapp.webhook_event.requeued",
    entityType: "wa_webhook_event",
    entityId: eventId,
    tenantId: event.tenant_id,
    after: { propertyId: event.property_id, status: "pending" },
  });
  return { eventId, status: "pending" as const };
}

/** Release a poison event after explicit operator review; this unblocks later phone events. */
export async function rejectMetaWebhookDeadLetter(
  admin: Db,
  userDb: Db,
  userId: string,
  eventId: string,
  rawReason: string,
) {
  const reason = rawReason
    .trim()
    .replace(/[\\r\\n\\t]+/g, " ")
    .slice(0, 200);
  if (reason.length < 10) throw new Error("A review reason of at least 10 characters is required.");

  const { data: event, error: lookupError } = await admin
    .from("wa_webhook_events")
    .select("id, tenant_id, property_id, status")
    .eq("id", eventId)
    .maybeSingle();
  if (
    lookupError ||
    !event ||
    event.status !== "dead_letter" ||
    !event.tenant_id ||
    !event.property_id
  ) {
    throw new Error("Dead-letter event is unavailable for operator rejection.");
  }

  await assertCapability(userDb, userId, event.tenant_id, "tenant.manage", {
    propertyId: event.property_id,
  });
  const { error } = await admin
    .from("wa_webhook_events")
    .update({
      status: "rejected",
      processed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: "operator_discarded_after_review",
    })
    .eq("id", eventId)
    .eq("status", "dead_letter");
  if (error) throw new Error("Dead-letter event could not be rejected.");

  await writeCommercialAudit(userDb, {
    actorId: userId,
    action: "whatsapp.webhook_event.rejected",
    entityType: "wa_webhook_event",
    entityId: eventId,
    tenantId: event.tenant_id,
    reason,
    after: { propertyId: event.property_id, status: "rejected" },
  });
  return { eventId, status: "rejected" as const };
}
