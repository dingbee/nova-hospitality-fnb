/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase catalog rows are validated and projected before leaving the server boundary. */
/**
 * Server-only bodies of the WhatsApp Guest Portal server functions
 * (guest-portal.functions.ts). Scope is derived exclusively from the
 * one-time bearer session; inputs arrive already schema-validated.
 */
import type { GuestPortalMenuInput, SubmitGuestCommerceOrderInput } from "./guest-portal.functions";

/** Browse-only WhatsApp landing page. */
export async function guestPortalMenu(data: GuestPortalMenuInput) {
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
  ] = await Promise.all([
    supabaseAdmin
      .from("restaurant_tenants")
      .select("name, settings, status")
      .eq("id", session.tenantId)
      .maybeSingle(),
    supabaseAdmin
      .from("restaurant_locations")
      .select("name, status, location_type, is_storage")
      .eq("id", session.locationId)
      .eq("tenant_id", session.tenantId)
      .eq("property_id", session.propertyId)
      .maybeSingle(),
    fetchSellableCatalog(supabaseAdmin, session.tenantId, {
      propertyId: session.propertyId,
      locationId: session.locationId,
      orderType: "takeaway",
    }),
    supabaseAdmin
      .from("wa_conversations")
      .select("guest_customer_id")
      .eq("id", session.conversationId)
      .eq("tenant_id", session.tenantId)
      .eq("property_id", session.propertyId)
      .eq("location_id", session.locationId)
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
    !["outlet", "restaurant", "bar"].includes(location.location_type)
  ) {
    throw new Error("This restaurant menu is not currently available.");
  }

  if (conversationError) throw new Error("Guest CRM context could not be resolved.");
  const { ingredientBackedMenuItemIds } =
    await import("@/modules/restaurant/selforder/guest-composition.server");
  const ingredientBackedIds = await ingredientBackedMenuItemIds(
    supabaseAdmin,
    session.tenantId,
    catalog.items.map((item: any) => item.id),
  );
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
      .filter(
        (item: any) =>
          ingredientBackedIds.has(item.id) && item.priceConfigured !== false && item.price !== null,
      )
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
}

/** WCE-04: submit a takeaway order through the existing authoritative sales engine. */
export async function submitGuestCommerceOrder(data: SubmitGuestCommerceOrderInput) {
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
      orderType: "takeaway",
    }),
  ]);
  if (tenantError || !tenant || tenant.status !== "active")
    throw new Error("The restaurant is not currently accepting orders.");

  const { ingredientBackedMenuItemIds } =
    await import("@/modules/restaurant/selforder/guest-composition.server");
  const ingredientBackedIds = await ingredientBackedMenuItemIds(
    supabaseAdmin,
    session.tenantId,
    catalog.items.map((item: any) => item.id),
  );
  const sellableIds = new Set(
    catalog.items
      .filter(
        (item: any) =>
          ingredientBackedIds.has(item.id) &&
          item.available !== false &&
          item.priceConfigured !== false,
      )
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
  const requestKey = "wa-guest:" + session.sessionId + ":" + data.clientRequestId;
  const order = await createGuestOrder(supabaseAdmin, {
    tenantId: session.tenantId,
    propertyId: session.propertyId,
    locationId: session.locationId,
    tableId: null,
    orderType: "takeaway",
    guestName: data.guestName || null,
    currency: session.currency,
    lines,
    clientRequestId: requestKey,
    guestPortalSessionId: session.sessionId,
    guestCustomerId,
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
    status: order.status,
    idempotent: Boolean(order.idempotent),
  };
}
