/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase rows are validated at this boundary. */
import { createWhatsAppGuestPortalSession } from "./guest-portal-sessions.server";

type Db = any;
type CommerceEvent = { id: string; tenant_id: string; property_id: string; location_id: string; binding_id: string };
type InboundMessage = { id: string; from: string; text?: { body?: string } };
export type GuestCommerceIntent = "menu" | "order" | "help" | "unknown";

export function classifyGuestCommerceIntent(value: unknown): GuestCommerceIntent {
  if (typeof value !== "string") return "unknown";
  const normalised = value.trim().toLocaleLowerCase().replace(/[.!?]+$/g, "");
  if (/^(menu|menyu|browse|catalogue|catalog|start|hi|hello|habari)$/.test(normalised)) return "menu";
  if (/^(order|oda|place order|buy)$/.test(normalised)) return "order";
  if (/^(help|msaada|support)$/.test(normalised)) return "help";
  return "unknown";
}

function replyText(intent: GuestCommerceIntent, url?: string): string {
  if (intent === "help") return "Karibu LexiBite. Reply MENU to browse the menu, ORDER to start an order, or STAFF for assistance.\nWelcome to LexiBite. Reply MENU to browse or ORDER to start an order.";
  if (!url) return "Karibu! Reply MENU to explore the menu and order securely through the restaurant's Guest Portal.\nWelcome! Reply MENU to explore the menu and order securely through the restaurant's Guest Portal.";
  return ["Karibu! Your restaurant menu is ready.", "Browse available items, select modifiers and place your order securely through the restaurant's Guest Portal:", url, "", "Welcome! Browse the live menu and complete your order through the secure Guest Portal."].join("\n");
}

/** WhatsApp is the acquisition/conversation channel; Guest Portal and existing LexiBite services remain authoritative for commerce. */
export async function handleWhatsAppGuestCommerceMessage(admin: Db, event: CommerceEvent, conversationId: string, inbound: InboundMessage) {
  const intent = classifyGuestCommerceIntent(inbound.text?.body);
  if (intent === "unknown") return { handled: false as const, reason: "unrecognised_intent" };

  const { data: binding, error: bindingError } = await admin.from("wa_phone_number_bindings")
    .select("id, tenant_id, property_id, location_id, integration_id, phone_number_id, status")
    .eq("id", event.binding_id).eq("tenant_id", event.tenant_id).eq("property_id", event.property_id)
    .eq("location_id", event.location_id).maybeSingle();
  if (bindingError || !binding || binding.status !== "active") throw new Error("whatsapp_commerce_binding_unavailable");

  const { data: integration, error: integrationError } = await admin.from("api_integrations")
    .select("id, status, config, provider, channel_key, integration_type")
    .eq("id", binding.integration_id).eq("tenant_id", event.tenant_id).eq("property_id", event.property_id).maybeSingle();
  if (integrationError || !integration || integration.status !== "active" || integration.provider !== "meta-whatsapp" || integration.channel_key !== "whatsapp" || integration.integration_type !== "channel") {
    throw new Error("whatsapp_commerce_integration_unavailable");
  }

  const { data: conversation, error: conversationError } = await admin.from("wa_conversations")
    .select("id, wa_user_id, status").eq("id", conversationId).eq("binding_id", binding.id)
    .eq("tenant_id", event.tenant_id).eq("property_id", event.property_id).eq("location_id", event.location_id).maybeSingle();
  if (conversationError || !conversation || conversation.wa_user_id !== inbound.from || !["open", "human_handoff"].includes(conversation.status)) {
    throw new Error("whatsapp_commerce_conversation_scope_invalid");
  }

  const { data: priorReply, error: priorReplyError } = await admin.from("wa_messages")
    .select("id").eq("conversation_id", conversationId).eq("direction", "outbound")
    .contains("payload", { reply_to_provider_message_id: inbound.id }).maybeSingle();
  if (priorReplyError) throw new Error("whatsapp_commerce_idempotency_lookup_failed");
  if (priorReply) return { handled: true as const, duplicate: true as const };

  let portalUrl: string | undefined;
  if (intent === "menu" || intent === "order") {
    const session = await createWhatsAppGuestPortalSession(admin, {
      tenantId: event.tenant_id, propertyId: event.property_id, locationId: event.location_id,
      bindingId: binding.id, conversationId, createdByEventId: event.id,
      menuContext: { source: "whatsapp", intent },
    });
    portalUrl = session.portalUrl;
  }

  const content = replyText(intent, portalUrl);
  const clientRequestId = "wa:" + inbound.id;
  const { data: queued, error: queueError } = await admin.from("wa_messages").insert({
    tenant_id: event.tenant_id, property_id: event.property_id, location_id: event.location_id,
    conversation_id: conversationId, provider_message_id: null, client_request_id: clientRequestId,
    direction: "outbound", message_type: "text", status: "queued", content,
    payload: { reply_to_provider_message_id: inbound.id, intent, portal_url_issued: Boolean(portalUrl) },
    next_attempt_at: new Date().toISOString(),
  }).select("id").single();
  if (queueError) {
    if (queueError.code === "23505") return { handled: true as const, duplicate: true as const };
    throw new Error("whatsapp_commerce_outbound_queue_failed");
  }
  return { handled: true as const, duplicate: false as const, intent, queuedMessageId: queued.id };
}
