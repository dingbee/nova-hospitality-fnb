/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase result rows are validated at this boundary. */
import { createHash, randomBytes } from "node:crypto";
import { resolveServiceConfiguration } from "@/modules/restaurant/operations/service-config";

type Db = any;
export type GuestCommerceChannel = "whatsapp" | "website" | "qr" | "social" | "direct" | "concierge";

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

function orderTypeFor(serviceMode: string, tableId: string | null): "dine_in" | "takeaway" | "room_service" {
  if (tableId) return "dine_in";
  if (["takeaway", "counter_service", "quick_service", "self_service"].includes(serviceMode)) return "takeaway";
  if (serviceMode === "room_service") return "room_service";
  // Browsing remains available for table-service outlets, but checkout is
  // explicitly blocked until the guest enters through a table-bound QR.
  return "dine_in";
}

/**
 * The single short-lived Guest Commerce capability used by all acquisition
 * channels. Scope is resolved from trusted server records; only the opaque
 * token is returned to the browser.
 */
export async function createGuestCommerceSession(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    locationId: string;
    sourceChannel: GuestCommerceChannel;
    bindingId?: string;
    conversationId?: string;
    createdByEventId?: string;
    tableId?: string;
    menuContext?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
) {
  const { data: tenant, error: tenantError } = await admin
    .from("restaurant_tenants")
    .select("id, status, settings")
    .eq("id", input.tenantId)
    .maybeSingle();
  if (tenantError || !tenant || tenant.status !== "active") {
    throw new Error("The restaurant tenant is not active.");
  }

  const { data: location, error: locationError } = await admin
    .from("restaurant_locations")
    .select("id, tenant_id, property_id, location_type, is_storage, status")
    .eq("id", input.locationId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (
    locationError ||
    !location ||
    location.status !== "active" ||
    location.is_storage ||
    !["outlet", "restaurant", "bar", "cafe", "store", "room_service"].includes(location.location_type)
  ) {
    throw new Error("The selected location is not an active customer-facing outlet.");
  }

  const { data: property, error: propertyError } = await admin
    .from("restaurant_properties")
    .select("currency, status")
    .eq("id", input.propertyId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (
    propertyError ||
    !property ||
    property.status !== "active" ||
    !/^[A-Z]{3}$/.test(property.currency ?? "")
  ) {
    throw new Error("The property currency is not configured or the property is inactive.");
  }

  let bindingId: string | null = null;
  let conversationId: string | null = null;
  let createdByEventId: string | null = null;
  if (input.sourceChannel === "whatsapp") {
    if (!input.bindingId || !input.conversationId || !input.createdByEventId) {
      throw new Error("A verified WhatsApp binding, conversation and webhook event are required.");
    }
    const { data: binding, error: bindingError } = await admin
      .from("wa_phone_number_bindings")
      .select("id, integration_id, status")
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
    const { data: conversation, error: conversationError } = await admin
      .from("wa_conversations")
      .select("id, binding_id, status")
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
      .select("id, status, binding_id")
      .eq("id", input.createdByEventId)
      .eq("binding_id", input.bindingId)
      .eq("tenant_id", input.tenantId)
      .eq("property_id", input.propertyId)
      .eq("location_id", input.locationId)
      .maybeSingle();
    if (eventError || !event || !["processing", "processed"].includes(event.status)) {
      throw new Error("A verified WhatsApp webhook event is required to create the session.");
    }
    bindingId = input.bindingId;
    conversationId = input.conversationId;
    createdByEventId = input.createdByEventId;
  } else if (input.bindingId || input.conversationId || input.createdByEventId) {
    throw new Error("Non-WhatsApp guest sessions cannot carry WhatsApp identity.");
  }

  let tableId: string | null = null;
  if (input.tableId) {
    if (input.sourceChannel !== "qr") {
      throw new Error("Table-bound guest sessions must originate from a QR entry.");
    }
    const { data: table, error: tableError } = await admin
      .from("restaurant_tables")
      .select("id, active, tenant_id, property_id, location_id")
      .eq("id", input.tableId)
      .eq("tenant_id", input.tenantId)
      .eq("property_id", input.propertyId)
      .eq("location_id", input.locationId)
      .maybeSingle();
    if (tableError || !table || table.active !== true) {
      throw new Error("The selected table is not active for this outlet.");
    }
    tableId = table.id;
  } else if (input.sourceChannel === "qr") {
    throw new Error("A table QR session requires a valid table.");
  }

  const service = resolveServiceConfiguration(tenant.settings);
  const orderType = orderTypeFor(service.serviceMode, tableId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const portalUrl = createPortalUrl(token);

  if (conversationId) {
    const { error: revokeError } = await admin
      .from("restaurant_guest_commerce_sessions")
      .update({ revoked_at: now.toISOString() })
      .eq("conversation_id", conversationId)
      .is("revoked_at", null)
      .gt("expires_at", now.toISOString());
    if (revokeError) throw new Error("Unable to rotate the previous Guest Portal session.");
  }

  const { data: created, error: createError } = await admin
    .from("restaurant_guest_commerce_sessions")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId,
      location_id: input.locationId,
      binding_id: bindingId,
      conversation_id: conversationId,
      created_by_event_id: createdByEventId,
      table_id: tableId,
      token_hash: tokenHash,
      scope: "guest_commerce",
      source_channel: input.sourceChannel,
      order_type: orderType,
      currency: property.currency,
      menu_context: input.menuContext ?? {},
      metadata: input.metadata ?? {},
      open_count: 0,
      max_open_count: SESSION_MAX_OPENS,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (createError || !created) throw new Error("Unable to persist the Guest Commerce session.");

  return {
    sessionId: created.id,
    token,
    portalUrl,
    expiresAt,
    currency: property.currency,
    sourceChannel: input.sourceChannel,
    orderType,
    scope: "guest_commerce" as const,
  };
}

/** Resolve a public store slug into a scoped session without accepting tenant/property IDs from the browser. */
export async function createGuestCommerceSessionForPublicStore(
  admin: Db,
  input: { tenantSlug: string; propertySlug: string; locationSlug: string; sourceChannel: "website" | "social" | "direct" },
) {
  const { data: tenant, error: tenantError } = await admin
    .from("restaurant_tenants")
    .select("id, status")
    .eq("slug", input.tenantSlug)
    .maybeSingle();
  if (tenantError || !tenant || tenant.status !== "active") {
    throw new Error("This restaurant storefront is not available.");
  }
  const { data: property, error: propertyError } = await admin
    .from("restaurant_properties")
    .select("id, status")
    .eq("tenant_id", tenant.id)
    .eq("slug", input.propertySlug)
    .maybeSingle();
  if (propertyError || !property || property.status !== "active") {
    throw new Error("This restaurant storefront is not available.");
  }
  const { data: location, error: locationError } = await admin
    .from("restaurant_locations")
    .select("id")
    .eq("tenant_id", tenant.id)
    .eq("property_id", property.id)
    .eq("slug", input.locationSlug)
    .maybeSingle();
  if (locationError || !location) {
    throw new Error("This restaurant storefront is not available.");
  }
  return createGuestCommerceSession(admin, {
    tenantId: tenant.id,
    propertyId: property.id,
    locationId: location.id,
    sourceChannel: input.sourceChannel,
  });
}

/** Table QR entry is resolved entirely from the table record, never from client-supplied tenant scope. */
export async function createGuestCommerceSessionForTable(admin: Db, tableId: string) {
  const { data: table, error } = await admin
    .from("restaurant_tables")
    .select("id, tenant_id, property_id, location_id, active")
    .eq("id", tableId)
    .maybeSingle();
  if (error || !table || table.active !== true || !table.property_id || !table.location_id) {
    throw new Error("This table is not available for guest ordering.");
  }
  return createGuestCommerceSession(admin, {
    tenantId: table.tenant_id,
    propertyId: table.property_id,
    locationId: table.location_id,
    sourceChannel: "qr",
    tableId: table.id,
  });
}

/** WCE-03 compatibility wrapper; WhatsApp uses the same commerce session authority as every other channel. */
export async function createWhatsAppGuestPortalSession(admin: Db, input: {
  tenantId: string;
  propertyId: string;
  locationId: string;
  bindingId: string;
  conversationId: string;
  createdByEventId: string;
  menuContext?: Record<string, unknown>;
}) {
  return createGuestCommerceSession(admin, {
    ...input,
    sourceChannel: "whatsapp",
  });
}

export async function resolveGuestCommerceSession(admin: Db, token: string) {
  if (!isValidToken(token)) return null;
  const { data, error } = await admin.rpc("restaurant_resolve_guest_commerce_session", {
    _token_hash: hashToken(token),
  });
  if (error) throw new Error("Guest Commerce session validation is unavailable.");
  const session = Array.isArray(data) ? data[0] : data;
  if (!session) return null;
  return {
    sessionId: session.session_id,
    tenantId: session.tenant_id,
    propertyId: session.property_id,
    locationId: session.location_id,
    bindingId: session.binding_id,
    conversationId: session.conversation_id,
    tableId: session.table_id,
    sourceChannel: session.source_channel as GuestCommerceChannel,
    orderType: session.order_type as "dine_in" | "takeaway" | "room_service",
    currency: session.currency,
    menuContext: session.menu_context,
    expiresAt: session.expires_at,
    scope: session.scope,
  };
}

/** WCE-03 compatibility wrapper. */
export const resolveWhatsAppGuestPortalSession = resolveGuestCommerceSession;

export async function revokeGuestCommerceSession(admin: Db, sessionId: string) {
  const { data, error } = await admin.rpc("restaurant_revoke_guest_commerce_session", {
    _session_id: sessionId,
  });
  if (error) throw new Error("Guest Commerce session revocation failed.");
  return data === true;
}

export const revokeWhatsAppGuestPortalSession = revokeGuestCommerceSession;
