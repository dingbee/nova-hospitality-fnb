/* eslint-disable @typescript-eslint/no-explicit-any -- service-role Supabase rows are projected into typed CRM records. */
type Db = any;

export function normalizeWhatsAppPhone(raw: string): { phoneE164: string; whatsappUserId: string } {
  const digits = raw.replace(/\D/g, "");
  if (!/^\d{8,15}$/.test(digits)) throw new Error("WhatsApp phone identity is invalid.");
  return { phoneE164: "+" + digits, whatsappUserId: digits };
}

export function detectGuestLanguage(text: string | null | undefined): "en" | "sw" {
  if (!text) return "en";
  const swahili =
    /\b(habari|tafadhali|asante|nataka|naomba|ndiyo|ndio|hapana|chakula|msaada|bei|karibu|pole|samahani|nime|tuna|wapi|lini)\b/i;
  return swahili.test(text) ? "sw" : "en";
}

export type WhatsAppConsentCommand = "subscribe" | "unsubscribe" | null;
export function parseWhatsAppConsentCommand(
  text: string | null | undefined,
): WhatsAppConsentCommand {
  const value = (text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "");
  if (["join", "subscribe", "start", "opt in", "opt-in"].includes(value)) return "subscribe";
  if (["stop", "unsubscribe", "opt out", "opt-out"].includes(value)) return "unsubscribe";
  return null;
}

export async function upsertWhatsAppGuestCustomer(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    phone: string;
    displayName?: string | null;
    messageText?: string | null;
  },
) {
  const identity = normalizeWhatsAppPhone(input.phone);
  const displayName = input.displayName?.trim().slice(0, 160) || null;
  const preferredLanguage = detectGuestLanguage(input.messageText);
  const now = new Date().toISOString();

  const { data: existing, error: lookupError } = await admin
    .from("restaurant_guest_customers")
    .select("id, display_name, first_property_id")
    .eq("tenant_id", input.tenantId)
    .eq("phone_e164", identity.phoneE164)
    .maybeSingle();
  if (lookupError) throw new Error("Guest CRM identity lookup failed.");

  if (existing) {
    const { data, error } = await admin
      .from("restaurant_guest_customers")
      .update({
        whatsapp_user_id: identity.whatsappUserId,
        display_name: displayName ?? existing.display_name,
        last_property_id: input.propertyId,
        preferred_language: preferredLanguage,
        last_seen_at: now,
      })
      .eq("id", existing.id)
      .eq("tenant_id", input.tenantId)
      .select("id, phone_e164, display_name, preferred_language, status")
      .single();
    if (error || !data) throw new Error("Guest CRM identity update failed.");
    return data;
  }

  const { data, error } = await admin
    .from("restaurant_guest_customers")
    .insert({
      tenant_id: input.tenantId,
      first_property_id: input.propertyId,
      last_property_id: input.propertyId,
      phone_e164: identity.phoneE164,
      whatsapp_user_id: identity.whatsappUserId,
      display_name: displayName,
      preferred_language: preferredLanguage,
      first_seen_at: now,
      last_seen_at: now,
    })
    .select("id, phone_e164, display_name, preferred_language, status")
    .single();
  if (error?.code === "23505") {
    return upsertWhatsAppGuestCustomer(admin, input);
  }
  if (error || !data) throw new Error("Guest CRM identity could not be created.");
  return data;
}

export async function recordWhatsAppGuestConsent(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    guestCustomerId: string;
    sourceEventId: string;
    state: "granted" | "revoked";
  },
) {
  const dedupeKey = "wa:" + input.sourceEventId + ":marketing:" + input.state;
  const { data, error } = await admin
    .from("restaurant_guest_customer_consents")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId,
      guest_customer_id: input.guestCustomerId,
      channel: "whatsapp",
      purpose: "marketing",
      state: input.state,
      evidence_source: "explicit_keyword",
      source_event_id: input.sourceEventId,
      dedupe_key: dedupeKey,
    })
    .select("id, state, recorded_at")
    .single();
  if (error?.code === "23505") return { duplicate: true as const, state: input.state };
  if (error || !data) throw new Error("WhatsApp marketing consent could not be recorded.");
  return {
    duplicate: false as const,
    state: data.state as "granted" | "revoked",
    recordedAt: data.recorded_at,
  };
}

/** Marketing is denied unless the latest immutable consent event is an explicit grant. */
export async function hasWhatsAppGuestMarketingConsent(
  admin: Db,
  tenantId: string,
  guestCustomerId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("restaurant_guest_customer_consents")
    .select("state")
    .eq("tenant_id", tenantId)
    .eq("guest_customer_id", guestCustomerId)
    .eq("channel", "whatsapp")
    .eq("purpose", "marketing")
    .order("recorded_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("WhatsApp consent state could not be verified.");
  return data?.state === "granted";
}

export async function getWhatsAppGuestCustomerHistory(
  admin: Db,
  tenantId: string,
  guestCustomerId: string,
) {
  const [{ data: orders, error: orderError }, marketingConsent] = await Promise.all([
    admin
      .from("restaurant_orders")
      .select("id, order_number, order_type, status, total, currency, opened_at, closed_at")
      .eq("tenant_id", tenantId)
      .eq("guest_customer_id", guestCustomerId)
      .order("opened_at", { ascending: false })
      .limit(10),
    hasWhatsAppGuestMarketingConsent(admin, tenantId, guestCustomerId),
  ]);
  if (orderError) throw new Error("Guest CRM order history could not be loaded.");
  const orderIds = (orders ?? []).map((order: any) => order.id);
  const { data: lines, error: linesError } = orderIds.length
    ? await admin
        .from("restaurant_order_items")
        .select("order_id, description, quantity")
        .eq("tenant_id", tenantId)
        .in("order_id", orderIds)
    : { data: [], error: null };
  if (linesError) throw new Error("Guest CRM order items could not be loaded.");
  const linesByOrder = new Map<string, Array<{ name: string; quantity: number }>>();
  for (const line of (lines ?? []) as any[]) {
    const list = linesByOrder.get(line.order_id) ?? [];
    list.push({ name: String(line.description ?? ""), quantity: Number(line.quantity ?? 0) });
    linesByOrder.set(line.order_id, list);
  }
  return {
    recentOrders: (orders ?? []).map((order: any) => ({
      orderNumber: order.order_number,
      orderType: order.order_type,
      status: order.status,
      total: Number(order.total ?? 0),
      currency: order.currency,
      openedAt: order.opened_at,
      closedAt: order.closed_at,
      items: linesByOrder.get(order.id) ?? [],
    })),
    whatsappMarketingConsent: marketingConsent,
  };
}


export async function awardGuestLoyaltyForCompletedOrder(
  admin: Db,
  tenantId: string,
  orderId: string,
) {
  const { data: order, error: orderError } = await admin.from("restaurant_orders")
    .select("id, tenant_id, property_id, guest_customer_id, status, total, currency")
    .eq("tenant_id", tenantId).eq("id", orderId).maybeSingle();
  if (orderError || !order) throw new Error("Completed guest order could not be resolved for loyalty.");
  if (order.status !== "closed" || !order.guest_customer_id || !order.property_id) {
    return { awarded: 0, reason: "not_a_completed_guest_order" as const };
  }
  const { data: program, error: programError } = await admin.from("restaurant_guest_loyalty_programs")
    .select("enabled, points_per_1000_units, minimum_order_total")
    .eq("tenant_id", tenantId).eq("property_id", order.property_id)
    .eq("currency", order.currency).maybeSingle();
  if (programError) throw new Error("Guest loyalty programme could not be resolved.");
  if (!program?.enabled || Number(order.total ?? 0) < Number(program.minimum_order_total ?? 0)) {
    return { awarded: 0, reason: "loyalty_program_disabled_or_minimum_not_met" as const };
  }
  const points = Math.floor((Number(order.total ?? 0) / 1000) * Number(program.points_per_1000_units ?? 0));
  if (points <= 0) return { awarded: 0, reason: "below_one_point" as const };
  const { error } = await admin.from("restaurant_guest_loyalty_ledger").insert({
    tenant_id: tenantId,
    property_id: order.property_id,
    guest_customer_id: order.guest_customer_id,
    currency: order.currency,
    entry_type: "earn",
    points_delta: points,
    amount_basis: Number(order.total ?? 0),
    reference_type: "restaurant_order",
    reference_id: order.id,
    idempotency_key: "order:" + order.id + ":earn",
    note: "Points awarded for completed order " + order.id,
  });
  if (error?.code === "23505") return { awarded: 0, reason: "already_awarded" as const };
  if (error) throw new Error("Guest loyalty points could not be awarded.");
  return { awarded: points, reason: "awarded" as const };
}

export async function requestWhatsAppHumanHandoff(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    locationId: string;
    conversationId: string;
    sourceEventId: string;
    reason: string;
  },
) {
  const { error: eventError } = await admin.from("wa_conversation_handoffs").insert({
    tenant_id: input.tenantId,
    property_id: input.propertyId,
    location_id: input.locationId,
    conversation_id: input.conversationId,
    source_event_id: input.sourceEventId,
    reason: input.reason.slice(0, 240),
    status: "requested",
  });
  if (eventError && eventError.code !== "23505") throw new Error("Human handoff request could not be recorded.");
  const { error: updateError } = await admin.from("wa_conversations").update({
    status: "human_handoff",
    handoff_requested_at: new Date().toISOString(),
    handoff_reason: input.reason.slice(0, 240),
  }).eq("id", input.conversationId).eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId).eq("location_id", input.locationId);
  if (updateError) throw new Error("WhatsApp conversation could not be moved to human handoff.");
  return { requested: true as const, duplicate: eventError?.code === "23505" };
}

function orderStatusMessage(status: string, orderNumber: string, language: "en" | "sw"): string | null {
  const messages: Record<string, { en: string; sw: string }> = {
    in_progress: { en: "Your order is being prepared.", sw: "Oda yako inaandaliwa." },
    preparing: { en: "Your order is being prepared.", sw: "Oda yako inaandaliwa." },
    ready: { en: "Your order is ready for collection.", sw: "Oda yako iko tayari kuchukuliwa." },
    dispatched: { en: "Your order is on its way.", sw: "Oda yako iko njiani." },
    closed: { en: "Your order is complete. Thank you for choosing us.", sw: "Oda yako imekamilika. Asante kwa kutuchagua." },
    cancelled: { en: "Your order was cancelled. Reply STAFF if you need assistance.", sw: "Oda yako imeghairiwa. Jibu STAFF ikiwa unahitaji msaada." },
    voided: { en: "Your order was cancelled. Reply STAFF if you need assistance.", sw: "Oda yako imeghairiwa. Jibu STAFF ikiwa unahitaji msaada." },
  };
  const message = messages[status];
  return message ? message[language] + " Order " + orderNumber + "." : null;
}

/** Persist every guest-order status event; send free-form text only inside Meta's 24-hour service window. */
export async function queueWhatsAppOrderStatusNotification(
  admin: Db,
  input: { tenantId: string; orderId: string; status: string },
) {
  const { data: order, error: orderError } = await admin.from("restaurant_orders")
    .select("id, tenant_id, property_id, location_id, order_number, status, guest_customer_id, guest_portal_session_id")
    .eq("tenant_id", input.tenantId).eq("id", input.orderId).maybeSingle();
  if (orderError || !order || !order.guest_portal_session_id) return { queued: false as const, reason: "not_a_guest_portal_order" };
  const messageStatus = orderStatusMessage(input.status, order.order_number, "en");
  if (!messageStatus) return { queued: false as const, reason: "status_not_customer_visible" };

  const { data: session, error: sessionError } = await admin.from("wa_guest_portal_sessions")
    .select("conversation_id")
    .eq("id", order.guest_portal_session_id)
    .eq("tenant_id", order.tenant_id)
    .eq("property_id", order.property_id)
    .eq("location_id", order.location_id)
    .maybeSingle();
  if (sessionError || !session?.conversation_id) return { queued: false as const, reason: "conversation_unavailable" };

  const { data: customer } = order.guest_customer_id
    ? await admin.from("restaurant_guest_customers").select("preferred_language")
        .eq("id", order.guest_customer_id).eq("tenant_id", order.tenant_id).maybeSingle()
    : { data: null };
  const language = customer?.preferred_language === "sw" ? "sw" : "en";
  const content = orderStatusMessage(input.status, order.order_number, language);
  if (!content) return { queued: false as const, reason: "status_not_customer_visible" };

  const { data: notification, error: notificationError } = await admin.from("wa_order_notification_events")
    .insert({
      tenant_id: order.tenant_id,
      property_id: order.property_id,
      location_id: order.location_id,
      order_id: order.id,
      guest_customer_id: order.guest_customer_id,
      conversation_id: session.conversation_id,
      order_status: input.status,
      notification_state: "pending",
    })
    .select("id")
    .single();
  if (notificationError?.code === "23505") return { queued: false as const, reason: "duplicate_status_event" };
  if (notificationError || !notification) throw new Error("WhatsApp order notification event could not be persisted.");

  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: lastInbound, error: inboundError } = await admin.from("wa_messages")
    .select("created_at")
    .eq("conversation_id", session.conversation_id)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (inboundError) throw new Error("WhatsApp customer service window could not be verified.");
  if (!lastInbound || lastInbound.created_at < windowStart) {
    await admin.from("wa_order_notification_events").update({ notification_state: "deferred_template" })
      .eq("id", notification.id).eq("tenant_id", order.tenant_id);
    return { queued: false as const, reason: "outside_customer_service_window" };
  }

  const clientRequestId = "wa-order:" + order.id + ":" + input.status;
  const { data: message, error: messageError } = await admin.from("wa_messages").insert({
    tenant_id: order.tenant_id,
    property_id: order.property_id,
    location_id: order.location_id,
    conversation_id: session.conversation_id,
    provider_message_id: null,
    client_request_id: clientRequestId,
    direction: "outbound",
    message_type: "text",
    status: "queued",
    content,
    payload: {
      notification_type: "order_status",
      order_notification_event_id: notification.id,
      order_id: order.id,
      order_status: input.status,
    },
    next_attempt_at: new Date().toISOString(),
  }).select("id").single();
  if (messageError?.code === "23505") {
    await admin.from("wa_order_notification_events").update({ notification_state: "queued" })
      .eq("id", notification.id).eq("tenant_id", order.tenant_id);
    return { queued: true as const, duplicate: true as const };
  }
  if (messageError || !message) throw new Error("WhatsApp order status message could not be queued.");
  const { error: updateError } = await admin.from("wa_order_notification_events").update({
    notification_state: "queued",
    message_id: message.id,
  }).eq("id", notification.id).eq("tenant_id", order.tenant_id);
  if (updateError) throw new Error("WhatsApp order notification state could not be updated.");
  return { queued: true as const, duplicate: false as const, messageId: message.id };
}
