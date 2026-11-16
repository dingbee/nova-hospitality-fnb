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

/** Idempotently enqueue the first WhatsApp-to-Portal handoff for a conversation. */
export async function enqueueWhatsAppGuestPortalHandoff(
  admin: Db,
  event: InboundEvent,
  conversationId: string,
  recipientPhone: string,
) {
  const { data: latestJob, error: jobLookupError } = await admin
    .from("wa_outbound_jobs")
    .select("id, status, portal_session_id")
    .eq("conversation_id", conversationId)
    .in("status", ["pending", "processing", "retry", "sent", "uncertain"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (jobLookupError) throw new Error("portal_handoff_job_lookup_failed");

  if (latestJob) {
    if (["pending", "processing", "retry", "uncertain"].includes(latestJob.status)) {
      return { queued: false, reason: "handoff_already_pending_or_uncertain" as const };
    }
    const { data: previousSession, error: sessionLookupError } = await admin
      .from("wa_guest_portal_sessions")
      .select("id, expires_at, revoked_at")
      .eq("id", latestJob.portal_session_id)
      .maybeSingle();
    if (sessionLookupError) throw new Error("portal_handoff_session_lookup_failed");
    if (
      latestJob.status === "sent" &&
      previousSession &&
      previousSession.revoked_at === null &&
      new Date(previousSession.expires_at).getTime() > Date.now()
    ) {
      return { queued: false, reason: "active_handoff_already_sent" as const };
    }
  }

  const { data: tenant, error: tenantError } = await admin
    .from("restaurant_tenants")
    .select("name, status, settings")
    .eq("id", event.tenant_id)
    .maybeSingle();
  if (tenantError || !tenant || tenant.status !== "active") {
    throw new Error("portal_handoff_tenant_unavailable");
  }

  const session = await createWhatsAppGuestPortalSession(admin, {
    tenantId: event.tenant_id,
    propertyId: event.property_id,
    locationId: event.location_id,
    bindingId: event.binding_id,
    conversationId,
    createdByEventId: event.id,
  });

  const settings = (tenant.settings ?? {}) as {
    business?: { tradingName?: string };
  };
  const businessName = (settings.business?.tradingName ?? "").trim() || tenant.name;
  const body = `Welcome to ${businessName}. Browse the menu and place your order securely here: ${session.portalUrl}`;
  const encrypted = encryptSecret(body);
  const idempotencyKey = `${event.id}:${conversationId}`;

  const { data: created, error: createError } = await admin
    .from("wa_outbound_jobs")
    .insert({
      tenant_id: event.tenant_id,
      property_id: event.property_id,
      location_id: event.location_id,
      binding_id: event.binding_id,
      conversation_id: conversationId,
      source_event_id: event.id,
      portal_session_id: session.sessionId,
      recipient_phone: recipientPhone,
      idempotency_key: idempotencyKey,
      message_type: "text",
      body_ciphertext: encrypted.ciphertext,
      body_iv: encrypted.iv,
      body_tag: encrypted.tag,
      status: "pending",
      next_attempt_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (createError?.code === "23505") {
    // A concurrent worker won the unique source-event/conversation race.
    // Revoke the losing token so no unqueued bearer link remains valid.
    await admin.rpc("wa_revoke_guest_portal_session", { _session_id: session.sessionId });
    return { queued: false, reason: "duplicate_handoff_job" as const };
  }
  if (createError || !created) throw new Error("portal_handoff_job_create_failed");

  return { queued: true, jobId: created.id, sessionId: session.sessionId };
}
