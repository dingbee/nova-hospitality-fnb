/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase result rows are validated at this boundary. */
import { createHash, randomBytes } from "node:crypto";

type Db = any;

const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX_OPENS = 20;

function createPortalUrl(token: string): string {
  const configured = process.env.LEXIBITE_GUEST_PORTAL_BASE_URL?.trim();
  if (!configured) throw new Error("Guest Portal base URL is not configured.");
  const base = new URL(configured);
  if (process.env.NODE_ENV === "production" && base.protocol !== "https:") {
    throw new Error("Guest Portal base URL must use HTTPS.");
  }
  return new URL(`/guest/${token}`, base).toString();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isValidToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * Create a short-lived, browse-only Guest Portal capability. Tenant/property/
 * outlet context is taken from verified server-side records, never the URL.
 */
export async function createWhatsAppGuestPortalSession(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    locationId: string;
    bindingId: string;
    conversationId: string;
    createdByEventId: string;
    menuContext?: Record<string, unknown>;
  },
) {
  const { data: binding, error: bindingError } = await admin
    .from("wa_phone_number_bindings")
    .select("id, tenant_id, property_id, location_id, integration_id, status")
    .eq("id", input.bindingId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  if (bindingError || !binding || binding.status !== "active") {
    throw new Error("An active WhatsApp receiving-number binding is required.");
  }

  const { data: integration, error: integrationError } = await admin
    .from("api_integrations")
    .select("id, status")
    .eq("id", binding.integration_id)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (integrationError || !integration || integration.status !== "active") {
    throw new Error("The WhatsApp integration is not active.");
  }

  const { data: location, error: locationError } = await admin
    .from("restaurant_locations")
    .select("id, location_type, is_storage, status")
    .eq("id", input.locationId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (
    locationError ||
    !location ||
    location.status !== "active" ||
    location.is_storage ||
    !["outlet", "restaurant", "bar"].includes(location.location_type)
  ) {
    throw new Error("The selected location is not an active customer-facing outlet.");
  }

  const { data: conversation, error: conversationError } = await admin
    .from("wa_conversations")
    .select("id, binding_id, tenant_id, property_id, location_id, status")
    .eq("id", input.conversationId)
    .eq("binding_id", input.bindingId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  if (
    conversationError ||
    !conversation ||
    !["open", "human_handoff"].includes(conversation.status)
  ) {
    throw new Error("The WhatsApp conversation is not valid for this outlet.");
  }

  const { data: event, error: eventError } = await admin
    .from("wa_webhook_events")
    .select("id, status, binding_id, tenant_id, property_id, location_id")
    .eq("id", input.createdByEventId)
    .eq("binding_id", input.bindingId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  if (eventError || !event || !["processing", "processed"].includes(event.status)) {
    throw new Error("A verified WhatsApp webhook event is required to create the session.");
  }

  const { data: property, error: propertyError } = await admin
    .from("restaurant_properties")
    .select("currency")
    .eq("id", input.propertyId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (propertyError || !property || !/^[A-Z]{3}$/.test(property.currency ?? "")) {
    throw new Error("The property currency is not configured.");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const portalUrl = createPortalUrl(token);

  const { error: revokeError } = await admin
    .from("wa_guest_portal_sessions")
    .update({ revoked_at: now.toISOString() })
    .eq("conversation_id", input.conversationId)
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString());
  if (revokeError) throw new Error("Unable to rotate the previous Guest Portal session.");

  const { data: created, error: createError } = await admin
    .from("wa_guest_portal_sessions")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId,
      location_id: input.locationId,
      binding_id: input.bindingId,
      conversation_id: input.conversationId,
      created_by_event_id: input.createdByEventId,
      token_hash: tokenHash,
      scope: "menu_browse",
      acquisition_channel: "whatsapp",
      currency: property.currency,
      menu_context: input.menuContext ?? {},
      open_count: 0,
      max_open_count: SESSION_MAX_OPENS,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (createError || !created) throw new Error("Unable to persist the Guest Portal session.");

  return {
    sessionId: created.id,
    token,
    portalUrl,
    expiresAt,
    currency: property.currency,
    scope: "menu_browse" as const,
  };
}

/** Resolve a browse-only token atomically, enforcing expiry, revocation and open-count limits. */
export async function resolveWhatsAppGuestPortalSession(admin: Db, token: string) {
  if (!isValidToken(token)) return null;
  const { data, error } = await admin.rpc("wa_resolve_guest_portal_session", {
    _token_hash: hashToken(token),
  });
  if (error) throw new Error("Guest Portal session validation is unavailable.");
  const session = Array.isArray(data) ? data[0] : data;
  if (!session) return null;

  return {
    sessionId: session.session_id,
    tenantId: session.tenant_id,
    propertyId: session.property_id,
    locationId: session.location_id,
    bindingId: session.binding_id,
    conversationId: session.conversation_id,
    currency: session.currency,
    menuContext: session.menu_context,
    expiresAt: session.expires_at,
    scope: session.scope,
  };
}

export async function revokeWhatsAppGuestPortalSession(admin: Db, sessionId: string) {
  const { data, error } = await admin.rpc("wa_revoke_guest_portal_session", {
    _session_id: sessionId,
  });
  if (error) throw new Error("Guest Portal session revocation failed.");
  return data === true;
}
