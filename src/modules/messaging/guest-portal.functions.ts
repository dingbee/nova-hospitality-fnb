/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase catalog rows are validated and projected before leaving the server boundary. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { guestLineSchema } from "@/modules/restaurant/selforder/selforder.contracts";

const guestPortalMenuSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  orderType: z.enum(["takeaway", "dine_in"]).default("takeaway"),
});

/** Browse-only WhatsApp landing page. Scope is derived exclusively from the one-time bearer session. */
export const guestPortalMenuFn = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => guestPortalMenuSchema.parse(value))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveWhatsAppGuestPortalSession } =
      await import("@/modules/messaging/guest-portal-sessions.server");
    const { fetchSellableCatalog } = await import("@/modules/restaurant/sales/pos.server");

    const session = await resolveWhatsAppGuestPortalSession(supabaseAdmin, data.token);
    if (!session || !["menu_browse", "guest_commerce"].includes(session.scope)) {
      throw new Error(
        "This Guest Portal link has expired or is no longer available. Return to WhatsApp and request a new menu link.",
      );
    }

    const [
      { data: tenant, error: tenantError },
      { data: location, error: locationError },
      catalog,
      { data: conversation, error: conversationError },
      { data: property, error: propertyError },
    ] = await Promise.all([
      supabaseAdmin
        .from("restaurant_tenants")
        .select("name, settings, status")
        .eq("id", session.tenantId)
        .maybeSingle(),
      supabaseAdmin
        .from("restaurant_locations")
        .select("name, status, location_type, is_storage, settings")
        .eq("id", session.locationId)
        .eq("tenant_id", session.tenantId)
        .eq("property_id", session.propertyId)
        .maybeSingle(),
      fetchSellableCatalog(supabaseAdmin, session.tenantId, {
        propertyId: session.propertyId,
        locationId: session.locationId,
        orderType: data.orderType,
      }),
      supabaseAdmin
        .from("wa_conversations")
        .select("guest_customer_id")
        .eq("id", session.conversationId)
        .eq("tenant_id", session.tenantId)
        .eq("property_id", session.propertyId)
        .eq("location_id", session.locationId)
        .maybeSingle(),
      supabaseAdmin
        .from("restaurant_properties")
        .select("timezone, settings, status")
        .eq("id", session.propertyId)
        .eq("tenant_id", session.tenantId)
        .maybeSingle(),
    ]);
    if (
      tenantError ||
      !tenant ||
      tenant.status !== "active" ||
      locationError ||
      !location ||
      location.status !== "active" ||
      location.is_storage ||
      !["outlet", "restaurant", "bar"].includes(location.location_type) ||
      propertyError ||
      !property ||
      property.status !== "active"
    ) {
      throw new Error("This restaurant menu is not currently available.");
    }

    if (conversationError) throw new Error("Guest CRM context could not be resolved.");
    const guestCustomerId = conversation?.guest_customer_id as string | null;
    const [{ data: guestCustomer }, loyaltyPointsBalance] = guestCustomerId
      ? await Promise.all([
          supabaseAdmin
            .from("restaurant_guest_customers")
            .select("display_name, status")
            .eq("id", guestCustomerId)
            .eq("tenant_id", session.tenantId)
            .maybeSingle(),
          supabaseAdmin.rpc("restaurant_guest_loyalty_balance", {
            _tenant_id: session.tenantId,
            _guest_customer_id: guestCustomerId,
          }),
        ])
      : [{ data: null }, 0];
    if (guestCustomer?.status === "blocked")
      throw new Error("This guest account is not permitted to place orders.");
    const settings = tenant.settings as {
      business?: { tradingName?: string; logoUrl?: string | null };
    } | null;
    const businessName = settings?.business?.tradingName?.trim() || tenant.name;
    return {
      businessName,
      logoUrl: settings?.business?.logoUrl?.trim() || null,
      outletName: location.name,
      guestName: guestCustomer?.display_name ?? null,
      timezone: property.timezone || "Africa/Dar_es_Salaam",
      reservationDurationMinutes: Number(
        location.settings?.reservations?.durationMinutes ??
          property.settings?.reservations?.durationMinutes ??
          90,
      ),
      loyaltyPointsBalance: Number(loyaltyPointsBalance ?? 0),
      currency: session.currency,
      categories: catalog.categories.map((category: any) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sort_order,
      })),
      modifierGroups: catalog.modifierGroups.map((group: any) => ({
        id: group.id,
        name: group.name,
        minSelect: group.min_select,
        maxSelect: group.max_select,
        required: group.required,
        modifiers: group.modifiers.map((modifier: any) => ({
          id: modifier.id,
          name: modifier.name,
          priceDelta: modifier.price_delta,
        })),
      })),
      items: catalog.items
        .filter((item: any) => item.priceConfigured !== false && item.price !== null)
        .map((item: any) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          price: item.price,
          currency: session.currency,
          imageUrl: item.image_url,
          categoryId: item.category_id,
          available: item.available !== false,
          availabilityReasons: item.availability_reasons ?? [],
          availableQuantity: item.available_quantity ?? null,
          modifierGroupIds: Array.isArray(item.modifier_group_ids) ? item.modifier_group_ids : [],
          variants: (item.variants ?? []).map((variant: any) => ({
            id: variant.id,
            name: variant.name,
            price: variant.price,
            priceIsDelta: variant.price_is_delta,
          })),
        })),
    };
  });

const submitGuestCommerceOrderSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  guestName: z.string().trim().max(160).optional(),
  clientRequestId: z.string().min(8).max(80),
  fulfilmentMethod: z.enum(["pickup", "dine_in"]).default("pickup"),
  reservationId: z.string().uuid().optional(),
  lines: z.array(guestLineSchema).min(1).max(50),
});

/** WCE-04: submit a takeaway order through the existing authoritative sales engine. */
export const submitGuestCommerceOrderFn = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => submitGuestCommerceOrderSchema.parse(value))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveWhatsAppGuestPortalSession } =
      await import("@/modules/messaging/guest-portal-sessions.server");
    const { fetchSellableCatalog } = await import("@/modules/restaurant/sales/pos.server");
    const { pickGuestOrderableLines } =
      await import("@/modules/restaurant/selforder/selforder.server");
    const { createGuestOrder } = await import("@/modules/restaurant/sales/sales.server");
    const { resolveGuestPaymentTiming } =
      await import("@/modules/restaurant/payments/payment-timing");
    const { fireGuestOrder } = await import("@/modules/restaurant/kitchen/kitchen.server");

    const session = await resolveWhatsAppGuestPortalSession(supabaseAdmin, data.token);
    if (!session || session.scope !== "guest_commerce") {
      throw new Error(
        "This Guest Portal session cannot submit orders. Return to WhatsApp and request a new menu link.",
      );
    }

    const [{ data: tenant, error: tenantError }, catalog] = await Promise.all([
      supabaseAdmin
        .from("restaurant_tenants")
        .select("id, settings, status")
        .eq("id", session.tenantId)
        .maybeSingle(),
      fetchSellableCatalog(supabaseAdmin, session.tenantId, {
        propertyId: session.propertyId,
        locationId: session.locationId,
        orderType: data.fulfilmentMethod === "dine_in" ? "dine_in" : "takeaway",
      }),
    ]);
    if (tenantError || !tenant || tenant.status !== "active")
      throw new Error("The restaurant is not currently accepting orders.");

    const sellableIds = new Set(
      catalog.items
        .filter((item: any) => item.available !== false && item.priceConfigured !== false)
        .map((item: any) => item.id as string),
    );
    const { valid, rejected } = pickGuestOrderableLines(sellableIds, data.lines);
    if (rejected.length || !valid.length) {
      throw new Error("One or more items are no longer available. Refresh the menu and try again.");
    }
    const stockExceeded = valid.some((line) => {
      const item = catalog.items.find((candidate: any) => candidate.id === line.menuItemId);
      return item?.available_quantity != null && line.quantity > Number(item.available_quantity);
    });
    if (stockExceeded)
      throw new Error(
        "The requested quantity exceeds current available stock. Update your cart and try again.",
      );

    const lines = valid.map((line) => ({
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: 0,
      discount: 0,
      taxAmount: 0,
      notes: line.notes,
      guestNotes: line.guestNotes,
      modifiers: line.modifiers,
    }));
    const { data: conversation, error: conversationError } = await supabaseAdmin
      .from("wa_conversations")
      .select("guest_customer_id")
      .eq("id", session.conversationId)
      .eq("tenant_id", session.tenantId)
      .eq("property_id", session.propertyId)
      .eq("location_id", session.locationId)
      .maybeSingle();
    if (conversationError || !conversation)
      throw new Error("The WhatsApp guest identity could not be verified.");
    const guestCustomerId = conversation.guest_customer_id as string | null;
    if (guestCustomerId && data.guestName?.trim()) {
      const { error: profileError } = await supabaseAdmin
        .from("restaurant_guest_customers")
        .update({ display_name: data.guestName.trim().slice(0, 160) })
        .eq("id", guestCustomerId)
        .eq("tenant_id", session.tenantId);
      if (profileError) throw new Error("The guest profile could not be updated.");
    }
    let tableId: string | null = null;
    let guestCount = 1;
    const orderType = data.fulfilmentMethod === "dine_in" ? "dine_in" : "takeaway";
    if (data.fulfilmentMethod === "dine_in") {
      if (!data.reservationId || !guestCustomerId) {
        throw new Error("A confirmed Guest Portal reservation is required for dine-in orders.");
      }
      const { data: reservation, error: reservationError } = await supabaseAdmin
        .from("restaurant_table_reservations")
        .select("id, table_id, party_size, starts_at, ends_at, status")
        .eq("id", data.reservationId)
        .eq("tenant_id", session.tenantId)
        .eq("property_id", session.propertyId)
        .eq("location_id", session.locationId)
        .eq("guest_customer_id", guestCustomerId)
        .eq("status", "confirmed")
        .maybeSingle();
      if (reservationError || !reservation?.table_id) {
        throw new Error("The dine-in reservation could not be verified.");
      }
      const now = Date.now();
      if (
        now < new Date(reservation.starts_at).getTime() - 30 * 60_000 ||
        now > new Date(reservation.ends_at).getTime()
      ) {
        throw new Error("Dine-in ordering is available from 30 minutes before your reservation until its end time.");
      }
      tableId = reservation.table_id;
      guestCount = Number(reservation.party_size);
    }

    const requestKey = "wa-guest:" + session.sessionId + ":" + data.clientRequestId;
    const order = await createGuestOrder(supabaseAdmin, {
      tenantId: session.tenantId,
      propertyId: session.propertyId,
      locationId: session.locationId,
      tableId,
      orderType,
      guestCount,
      guestName: data.guestName || null,
      currency: session.currency,
      lines,
      clientRequestId: requestKey,
      guestPortalSessionId: session.sessionId,
      guestCustomerId,
      guestReservationId: data.fulfilmentMethod === "dine_in" ? data.reservationId : null,
    });

    const paymentTiming = resolveGuestPaymentTiming(tenant.settings);
    if (!order.idempotent && paymentTiming === "pay_after_service") {
      await fireGuestOrder(supabaseAdmin, { tenantId: session.tenantId, orderId: order.id });
    }
    return {
      orderId: order.id,
      orderNumber: order.order_number,
      total: Number(order.total ?? 0),
      currency: session.currency,
      paymentTiming,
      fulfilmentMethod: data.fulfilmentMethod,
      status: order.status,
      idempotent: Boolean(order.idempotent),
    };
  });


const guestPortalPaymentSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  orderId: z.string().uuid(),
});
const guestPortalPaymentConfirmationSchema = guestPortalPaymentSchema.extend({
  orderTrackingId: z.string().min(1).max(200),
});

async function loadGuestPortalPaymentOrder(admin: any, session: any, orderId: string) {
  const { data: order, error } = await admin
    .from("restaurant_orders")
    .select("id, tenant_id, property_id, location_id, guest_portal_session_id, order_number, status, payment_state, total, paid_total, currency, bill_requested_at")
    .eq("id", orderId)
    .eq("tenant_id", session.tenantId)
    .eq("property_id", session.propertyId)
    .eq("location_id", session.locationId)
    .eq("guest_portal_session_id", session.sessionId)
    .maybeSingle();
  if (error || !order) throw new Error("This order is not available in the current Guest Portal session.");
  return order;
}

/** WCE-06: start a hosted payment for the session's own order using the exact property's encrypted payment integration. */
export const initiateGuestCommercePaymentFn = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => guestPortalPaymentSchema.parse(value))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveWhatsAppGuestPortalSession } =
      await import("@/modules/messaging/guest-portal-sessions.server");
    const { initiateGuestOrderPayment } = await import("@/modules/restaurant/selforder/selfpay.server");
    const session = await resolveWhatsAppGuestPortalSession(supabaseAdmin, data.token);
    if (!session || session.scope !== "guest_commerce") {
      throw new Error("This Guest Portal session cannot initiate payment. Request a fresh link from WhatsApp.");
    }
    const order = await loadGuestPortalPaymentOrder(supabaseAdmin, session, data.orderId);
    const base = process.env.APP_BASE_URL;
    if (!base) throw new Error("The secure payment return URL is not configured.");
    const parsed = new URL(base);
    if (parsed.protocol !== "https:") throw new Error("The payment return URL must use HTTPS.");
    const returnUrl = new URL(
      `/guest/${data.token}/payment?orderId=${encodeURIComponent(order.id)}`,
      parsed,
    ).toString();
    return initiateGuestOrderPayment(
      supabaseAdmin,
      {
        id: order.id,
        tenantId: session.tenantId,
        propertyId: session.propertyId,
        orderNumber: order.order_number,
        status: order.status,
        total: Number(order.total),
        paidTotal: Number(order.paid_total),
        currency: order.currency,
        billRequestedAt: order.bill_requested_at,
      },
      returnUrl,
    );
  });

/** WCE-06: verify a browser return against Pesapal again; URL status is never treated as proof of payment. */
export const confirmGuestCommercePaymentFn = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => guestPortalPaymentConfirmationSchema.parse(value))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveWhatsAppGuestPortalSession } =
      await import("@/modules/messaging/guest-portal-sessions.server");
    const { confirmGuestPayment } = await import("@/modules/restaurant/selforder/selfpay.server");
    const session = await resolveWhatsAppGuestPortalSession(supabaseAdmin, data.token);
    if (!session || session.scope !== "guest_commerce") {
      throw new Error("This Guest Portal session has expired. Return to WhatsApp and request a new link.");
    }
    const order = await loadGuestPortalPaymentOrder(supabaseAdmin, session, data.orderId);
    return confirmGuestPayment(
      supabaseAdmin,
      {
        id: order.id,
        tenantId: session.tenantId,
        propertyId: session.propertyId,
        currency: order.currency,
        total: Number(order.total),
        paidTotal: Number(order.paid_total),
      },
      data.orderTrackingId,
    );
  });


const guestReservationAvailabilitySchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  localStart: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/),
  partySize: z.number().int().min(1).max(30),
});

/** WCE-06: availability preview; final table assignment is repeated transactionally by the database RPC. */
export const checkGuestReservationAvailabilityFn = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => guestReservationAvailabilitySchema.parse(value))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { checkGuestReservationAvailability } =
      await import("@/modules/messaging/guest-reservations.server");
    return checkGuestReservationAvailability(supabaseAdmin, data);
  });

const createGuestReservationSchema = guestReservationAvailabilitySchema.extend({
  guestName: z.string().trim().max(160).optional(),
  clientRequestId: z.string().min(8).max(80),
});

/** WCE-06: create a table reservation against the outlet's canonical table inventory. */
export const createGuestReservationFn = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => createGuestReservationSchema.parse(value))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createGuestTableReservation } =
      await import("@/modules/messaging/guest-reservations.server");
    return createGuestTableReservation(supabaseAdmin, data);
  });


const cancelGuestReservationSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  reservationId: z.string().uuid(),
});

/** WCE-06: guests can cancel only their own future reservation from the same portal session. */
export const cancelGuestReservationFn = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => cancelGuestReservationSchema.parse(value))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { cancelGuestTableReservation } =
      await import("@/modules/messaging/guest-reservations.server");
    return cancelGuestTableReservation(supabaseAdmin, data);
  });
