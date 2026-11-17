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
