/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase rows are validated at this boundary. */
import { randomUUID } from "node:crypto";
import { getIntegrationSecret } from "@/modules/api-platform/integrations.server";
import { MetaGraphError, sendTextMessage } from "./providers/meta-cloud-api.server";

type Db = any;
type Outbound = { id: string; tenant_id: string; property_id: string; location_id: string; conversation_id: string; content: string; delivery_attempts: number };

export async function processPendingWhatsAppOutboundMessages(admin: Db, options: { limit?: number; workerId?: string } = {}) {
  const workerId = options.workerId ?? randomUUID();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const { data, error } = await admin.rpc("wa_claim_outbound_messages", {
    _limit: limit, _lease_seconds: 90, _worker_id: workerId,
  });
  if (error) throw new Error("whatsapp_outbox_claim_failed");
  const messages = Array.isArray(data) ? data as Outbound[] : [];
  let sent = 0;
  let retried = 0;
  let failed = 0;

  for (const message of messages) {
    try {
      const { data: conversation, error: conversationError } = await admin.from("wa_conversations")
        .select("binding_id, wa_user_id, status")
        .eq("id", message.conversation_id).eq("tenant_id", message.tenant_id)
        .eq("property_id", message.property_id).eq("location_id", message.location_id).maybeSingle();
      if (conversationError || !conversation || !["open", "human_handoff"].includes(conversation.status)) {
        throw new Error("whatsapp_outbox_conversation_unavailable");
      }

      const { data: binding, error: bindingError } = await admin.from("wa_phone_number_bindings")
        .select("id, phone_number_id, integration_id, status")
        .eq("id", conversation.binding_id).eq("tenant_id", message.tenant_id)
        .eq("property_id", message.property_id).eq("location_id", message.location_id).maybeSingle();
      if (bindingError || !binding || binding.status !== "active") throw new Error("whatsapp_outbox_binding_unavailable");

      const { data: integration, error: integrationError } = await admin.from("api_integrations")
        .select("id, status, config, provider, channel_key, integration_type")
        .eq("id", binding.integration_id).eq("tenant_id", message.tenant_id)
        .eq("property_id", message.property_id).maybeSingle();
      if (integrationError || !integration || integration.status !== "active" ||
          integration.provider !== "meta-whatsapp" || integration.channel_key !== "whatsapp" ||
          integration.integration_type !== "channel") throw new Error("whatsapp_outbox_integration_unavailable");

      const token = await getIntegrationSecret(admin, message.tenant_id, integration.id);
      if (!token) throw new Error("whatsapp_outbox_credential_unavailable");
      const result = await sendTextMessage({
        accessToken: token,
        wabaId: String(integration.config?.wabaId ?? ""),
        phoneNumberId: binding.phone_number_id,
      }, conversation.wa_user_id, message.content, {
        graphApiVersion: integration.config?.graphApiVersion,
      });
      const providerMessageId = result.messages?.[0]?.id;
      if (!providerMessageId) throw new Error("whatsapp_outbox_provider_id_missing");

      const { error: updateError } = await admin.from("wa_messages").update({
        provider_message_id: providerMessageId, status: "sent",
        sent_at: new Date().toISOString(), locked_at: null, locked_by: null, last_error: null,
      }).eq("id", message.id).eq("status", "queued").eq("locked_by", workerId);
      if (updateError) throw new Error("whatsapp_outbox_sent_state_failed");
      sent++;
    } catch (error) {
      // Only an explicit Meta rate-limit response is automatically retried.
      // Network/5xx outcomes are ambiguous: mark failed for operator review
      // rather than risk sending a duplicate message after provider acceptance.
      const retryable = error instanceof MetaGraphError && error.status === 429;
      const delay = error instanceof MetaGraphError && error.retryAfterMs !== null
        ? Math.min(3600, Math.ceil(error.retryAfterMs / 1000))
        : Math.min(3600, 5 * 2 ** Math.min(message.delivery_attempts - 1, 10));
      const { error: stateError } = await admin.from("wa_messages").update({
        status: retryable && message.delivery_attempts < 8 ? "queued" : "failed",
        next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
        locked_at: null, locked_by: null,
        last_error: retryable ? "provider_rate_limited" : "delivery_requires_operator_review",
      }).eq("id", message.id).eq("status", "queued").eq("locked_by", workerId);
      if (stateError) throw new Error("whatsapp_outbox_failure_state_failed");
      if (retryable && message.delivery_attempts < 8) retried++;
      else failed++;
    }
  }
  return { claimed: messages.length, sent, retried, failed };
}
