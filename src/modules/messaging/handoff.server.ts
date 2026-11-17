/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase rows are validated at this boundary. */
import { encryptSecret } from "@/modules/api-platform/crypto.server";
import { createWhatsAppGuestPortalSession } from "@/modules/messaging/guest-portal-sessions.server";

type Db = any;
type InboundEvent = {
  id: string;
  tenant_id: string;
  property_id: string;
  location_id: string;
  binding_id: string;
};

const BLOCKING_JOB_STATES = ["pending", "processing", "retry", "uncertain"];

async function sessionIsActive(admin: Db, sessionId: string | null) {
  if (!sessionId) return false;
  const { data, error } = await admin
    .from("wa_guest_portal_sessions")
    .select("id, expires_at, revoked_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error("portal_handoff_session_lookup_failed");
  return Boolean(data && data.revoked_at === null && new Date(data.expires_at).getTime() > Date.now());
}

async function buildEncryptedHandoff(admin: Db, event: InboundEvent, conversationId: string) {
  const [tenantResult, locationResult] = await Promise.all([
    admin
      .from("restaurant_tenants")
      .select("name, status, settings")
      .eq("id", event.tenant_id)
      .maybeSingle(),
    admin
      .from("restaurant_locations")
      .select("name, status, location_type, is_storage")
      .eq("id", event.location_id)
      .eq("tenant_id", event.tenant_id)
      .eq("property_id", event.property_id)
      .maybeSingle(),
  ]);
  const tenant = tenantResult.data;
  const location = locationResult.data;
  if (!tenant || tenant.status !== "active" || !location || location.status !== "active" || location.is_storage) {
    throw new Error("portal_handoff_context_unavailable");
  }

  const settings = (tenant.settings ?? {}) as { business?: { tradingName?: string } };
  const businessName = (settings.business?.tradingName ?? "").trim() || tenant.name;
  const outletLabel = location.name ? ` at ${location.name}` : "";
  let session: { sessionId: string; portalUrl: string } | null = null;
  let body: string;
  try {
    session = await createWhatsAppGuestPortalSession(admin, {
      tenantId: event.tenant_id,
      propertyId: event.property_id,
      locationId: event.location_id,
      bindingId: event.binding_id,
      conversationId,
      createdByEventId: event.id,
    });
    body = `Welcome to ${businessName}${outletLabel}. Browse the menu and place your order securely here: ${session.portalUrl}`;
  } catch {
    body = `Welcome to ${businessName}${outletLabel}. We could not prepare your menu link just now. Please try again shortly or reply HELP for assistance.`;
  }
  const encrypted = encryptSecret(body);
  return { session, encrypted };
}

/** Idempotently enqueue the first WhatsApp-to-Portal handoff for a conversation. */
export async function enqueueWhatsAppGuestPortalHandoff(
  admin: Db,
  event: InboundEvent,
  conversationId: string,
  recipientPhone: string,
) {
  const { data: eventJob, error: eventJobError } = await admin
    .from("wa_outbound_jobs")
    .select("id, status, portal_session_id")
    .eq("source_event_id", event.id)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (eventJobError) throw new Error("portal_handoff_job_lookup_failed");

  if (eventJob && (BLOCKING_JOB_STATES.includes(eventJob.status) || eventJob.status === "sent")) {
    return { queued: false, reason: "handoff_already_pending_or_active" as const };
  }

  if (!eventJob) {
    const { data: latestJob, error: latestJobError } = await admin
      .from("wa_outbound_jobs")
      .select("id, status, portal_session_id")
      .eq("conversation_id", conversationId)
      .in("status", ["pending", "processing", "retry", "sent", "uncertain"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestJobError) throw new Error("portal_handoff_job_lookup_failed");
    if (
      latestJob &&
      (BLOCKING_JOB_STATES.includes(latestJob.status) ||
        latestJob.status === "sent" && await sessionIsActive(admin, latestJob.portal_session_id))
    ) {
      return { queued: false, reason: "conversation_has_active_handoff" as const };
    }
  }

  const { session, encrypted } = await buildEncryptedHandoff(admin, event, conversationId);
  const patch = {
    tenant_id: event.tenant_id,
    property_id: event.property_id,
    location_id: event.location_id,
    binding_id: event.binding_id,
    conversation_id: conversationId,
    source_event_id: event.id,
    portal_session_id: session?.sessionId ?? null,
    recipient_phone: recipientPhone,
    idempotency_key: `${event.id}:${conversationId}`,
    message_type: "text",
    body_ciphertext: encrypted.ciphertext,
    body_iv: encrypted.iv,
    body_tag: encrypted.tag,
    status: "pending",
    attempt_count: 0,
    next_attempt_at: new Date().toISOString(),
    locked_at: null,
    locked_by: null,
    provider_message_id: null,
    last_error: null,
    sent_at: null,
  };

  if (eventJob) {
    const { error } = await admin
      .from("wa_outbound_jobs")
      .update(patch)
      .eq("id", eventJob.id)
      .eq("status", eventJob.status);
    if (error) {
      if (session) await admin.rpc("wa_revoke_guest_portal_session", { _session_id: session.sessionId });
      throw new Error("portal_handoff_job_requeue_failed");
    }
    return { queued: true, jobId: eventJob.id, sessionId: session?.sessionId ?? null };
  }

  const { data: created, error: createError } = await admin
    .from("wa_outbound_jobs")
    .insert(patch)
    .select("id")
    .single();

  if (createError?.code === "23505") {
    // A concurrent worker won the unique source-event/conversation race.
    // Revoke the losing token so no unqueued bearer link remains valid.
    if (session) {
      await admin.rpc("wa_revoke_guest_portal_session", { _session_id: session.sessionId });
    }
    return { queued: false, reason: "duplicate_handoff_job" as const };
  }
  if (createError || !created) {
    if (session) {
      await admin.rpc("wa_revoke_guest_portal_session", { _session_id: session.sessionId });
    }
    throw new Error("portal_handoff_job_create_failed");
  }

  return { queued: true, jobId: created.id, sessionId: session?.sessionId ?? null, fallback: !session };
}
