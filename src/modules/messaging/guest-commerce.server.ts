/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase rows are validated at this boundary. */
import { askNova } from "@/modules/restaurant/selforder/selfnova.server";
import { createWhatsAppGuestPortalSession } from "./guest-portal-sessions.server";
import {
  getWhatsAppGuestCustomerHistory,
  parseWhatsAppConsentCommand,
  recordWhatsAppGuestConsent,
  requestWhatsAppHumanHandoff,
} from "./guest-crm.server";

type Db = any;
type CommerceEvent = {
  id: string;
  tenant_id: string;
  property_id: string;
  location_id: string;
  binding_id: string;
};
type InboundMessage = { id: string; from: string; text?: { body?: string } };
export type GuestCommerceIntent =
  "menu" | "order" | "help" | "subscribe" | "unsubscribe" | "handoff" | "unknown";

export function classifyGuestCommerceIntent(value: unknown): GuestCommerceIntent {
  if (typeof value !== "string") return "unknown";
  const normalised = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?]+$/g, "");
  const consent = parseWhatsAppConsentCommand(normalised);
  if (consent === "subscribe") return "subscribe";
  if (consent === "unsubscribe") return "unsubscribe";
  if (/^(menu|menyu|browse|catalogue|catalog|start|hi|hello|habari)$/.test(normalised))
    return "menu";
  if (/^(order|oda|place order|buy)$/.test(normalised)) return "order";
  if (/^(help|msaada|support)$/.test(normalised)) return "help";
  if (/^(staff|agent|human|representative|mtu)$/.test(normalised)) return "handoff";
  return "unknown";
}

function replyText(intent: GuestCommerceIntent, url?: string): string {
  if (intent === "help") {
    return "Karibu LexiBite. Reply MENU to browse, ORDER to start an order, JOIN to receive offers, or STOP to opt out.\nWelcome to LexiBite. Reply MENU to browse, ORDER to start, JOIN for offers, or STOP to opt out.";
  }
  if (intent === "subscribe") {
    return "Asante! You are now subscribed to WhatsApp offers and marketing updates from this restaurant. Reply STOP at any time to opt out.\nThank you. You have opted in to WhatsApp offers and marketing updates. Reply STOP at any time to opt out.";
  }
  if (intent === "unsubscribe") {
    return "Umeondolewa kwenye matangazo ya WhatsApp. Hutapokea tena ofa za masoko.\nYou have been unsubscribed from WhatsApp marketing messages.";
  }
  if (intent === "handoff") {
    return "Timu yetu itajiunga na mazungumzo haya hivi karibuni.\nA team member has been requested and will join this conversation shortly.";
  }
  if (!url) {
    return "Karibu! Reply MENU to explore the menu and order securely through the restaurant's Guest Portal.\nWelcome! Reply MENU to explore the menu and order securely through the restaurant's Guest Portal.";
  }
  return [
    "Karibu! Your restaurant menu is ready.",
    "Browse available items, select modifiers and place your order securely through the restaurant's Guest Portal:",
    url,
    "",
    "Welcome! Browse the live menu and complete your order through the secure Guest Portal.",
  ].join("\n");
}

/** WhatsApp is the acquisition/conversation channel; Guest Portal and existing LexiBite services remain authoritative for commerce. */
export async function handleWhatsAppGuestCommerceMessage(
  admin: Db,
  event: CommerceEvent,
  conversationId: string,
  inbound: InboundMessage,
) {
  const messageText = inbound.text?.body?.trim();
  if (!messageText) return { handled: false as const, reason: "non_text_message" };
  const intent = classifyGuestCommerceIntent(messageText);

  const { data: binding, error: bindingError } = await admin
    .from("wa_phone_number_bindings")
    .select("id, tenant_id, property_id, location_id, integration_id, phone_number_id, status")
    .eq("id", event.binding_id)
    .eq("tenant_id", event.tenant_id)
    .eq("property_id", event.property_id)
    .eq("location_id", event.location_id)
    .maybeSingle();
  if (bindingError || !binding || binding.status !== "active") {
    throw new Error("whatsapp_commerce_binding_unavailable");
  }

  const { data: integration, error: integrationError } = await admin
    .from("api_integrations")
    .select("id, status, config, provider, channel_key, integration_type")
    .eq("id", binding.integration_id)
    .eq("tenant_id", event.tenant_id)
    .eq("property_id", event.property_id)
    .maybeSingle();
  if (
    integrationError ||
    !integration ||
    integration.status !== "active" ||
    integration.provider !== "meta-whatsapp" ||
    integration.channel_key !== "whatsapp" ||
    integration.integration_type !== "channel"
  ) {
    throw new Error("whatsapp_commerce_integration_unavailable");
  }

  const { data: conversation, error: conversationError } = await admin
    .from("wa_conversations")
    .select("id, wa_user_id, status, guest_customer_id")
    .eq("id", conversationId)
    .eq("binding_id", binding.id)
    .eq("tenant_id", event.tenant_id)
    .eq("property_id", event.property_id)
    .eq("location_id", event.location_id)
    .maybeSingle();
  if (
    conversationError ||
    !conversation ||
    conversation.wa_user_id !== inbound.from ||
    !["open", "human_handoff"].includes(conversation.status)
  ) {
    throw new Error("whatsapp_commerce_conversation_scope_invalid");
  }

  const { data: priorReply, error: priorReplyError } = await admin
    .from("wa_messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .contains("payload", { reply_to_provider_message_id: inbound.id })
    .maybeSingle();
  if (priorReplyError) throw new Error("whatsapp_commerce_idempotency_lookup_failed");
  if (priorReply) return { handled: true as const, duplicate: true as const };

  if (intent === "handoff") {
    await requestWhatsAppHumanHandoff(admin, {
      tenantId: event.tenant_id,
      propertyId: event.property_id,
      locationId: event.location_id,
      conversationId,
      sourceEventId: event.id,
      reason: "Guest requested a human team member via WhatsApp.",
    });
  }

  if (intent === "subscribe" || intent === "unsubscribe") {
    if (!conversation.guest_customer_id) throw new Error("whatsapp_guest_customer_unavailable");
    await recordWhatsAppGuestConsent(admin, {
      tenantId: event.tenant_id,
      propertyId: event.property_id,
      guestCustomerId: conversation.guest_customer_id,
      sourceEventId: event.id,
      state: intent === "subscribe" ? "granted" : "revoked",
    });
  }

  let portalUrl: string | undefined;
  let content: string;
  if (intent === "menu" || intent === "order") {
    const session = await createWhatsAppGuestPortalSession(admin, {
      tenantId: event.tenant_id,
      propertyId: event.property_id,
      locationId: event.location_id,
      bindingId: binding.id,
      conversationId,
      createdByEventId: event.id,
      menuContext: { source: "whatsapp", intent },
    });
    portalUrl = session.portalUrl;
    content = replyText(intent, portalUrl);
  } else if (intent === "unknown" && conversation.status === "human_handoff") {
    content =
      "A team member is handling this conversation. Please wait for their reply.\nMjumbe wa timu yetu anashughulikia mazungumzo haya. Tafadhali subiri.";
  } else if (intent === "unknown") {
    const { data: historyRows, error: historyError } = await admin
      .from("wa_messages")
      .select("direction, content")
      .eq("conversation_id", conversationId)
      .neq("provider_message_id", inbound.id)
      .not("content", "is", null)
      .order("created_at", { ascending: false })
      .limit(6);
    if (historyError) throw new Error("whatsapp_concierge_history_unavailable");
    const history = (historyRows ?? []).reverse().map((row: any) => ({
      role: row.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: String(row.content ?? ""),
    }));
    let conciergeReply =
      "I can help with menu questions and recommendations. Reply MENU or ORDER to open the secure Guest Portal.";
    try {
      let customerContext:
        | {
            displayName?: string | null;
            recentOrders?: Array<{
              orderNumber: string;
              status: string;
              items: Array<{ name: string; quantity: number }>;
            }>;
            loyaltyPointsBalance?: number;
          }
        | undefined;
      if (conversation.guest_customer_id) {
        const [{ data: customer }, crmHistory] = await Promise.all([
          admin
            .from("restaurant_guest_customers")
            .select("display_name")
            .eq("id", conversation.guest_customer_id)
            .eq("tenant_id", event.tenant_id)
            .maybeSingle(),
          getWhatsAppGuestCustomerHistory(admin, event.tenant_id, conversation.guest_customer_id),
        ]);
        customerContext = {
          displayName: customer?.display_name ?? null,
          recentOrders: crmHistory.recentOrders.slice(0, 5).map((order) => ({
            orderNumber: order.orderNumber,
            status: order.status,
            items: order.items,
          })),
          loyaltyPointsBalance: crmHistory.loyaltyPointsBalance,
        };
      }
      const result = await askNova(admin, {
        guestPortalScope: {
          tenantId: event.tenant_id,
          propertyId: event.property_id,
          locationId: event.location_id,
        },
        message: messageText,
        history,
        customerContext,
        interactionMode: "discovery",
      });
      if (result.ok) conciergeReply = result.reply;
    } catch {
      // Entitlement, quota, provider or grounding failures degrade to a
      // safe, non-AI menu handoff. No ungrounded response is sent.
    }
    content = conciergeReply + "\n\nReply MENU or ORDER to browse and submit your order securely.";
  } else {
    content = replyText(intent);
  }

  const clientRequestId = "wa:" + inbound.id;
  const { data: queued, error: queueError } = await admin
    .from("wa_messages")
    .insert({
      tenant_id: event.tenant_id,
      property_id: event.property_id,
      location_id: event.location_id,
      conversation_id: conversationId,
      provider_message_id: null,
      client_request_id: clientRequestId,
      direction: "outbound",
      message_type: "text",
      status: "queued",
      content,
      payload: {
        reply_to_provider_message_id: inbound.id,
        intent,
        portal_url_issued: Boolean(portalUrl),
      },
      next_attempt_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (queueError) {
    if (queueError.code === "23505") return { handled: true as const, duplicate: true as const };
    throw new Error("whatsapp_commerce_outbound_queue_failed");
  }
  return { handled: true as const, duplicate: false as const, intent, queuedMessageId: queued.id };
}
