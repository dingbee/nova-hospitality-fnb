/* eslint-disable @typescript-eslint/no-explicit-any -- service-role rows are validated at this boundary. */
import { resolveGuestCommerceSession } from "@/modules/messaging/guest-portal-sessions.server";
import { resolveGuestPaymentTiming } from "@/modules/restaurant/payments/payment-timing";
import { mergePropertyServiceSettings, resolveServiceConfiguration } from "@/modules/restaurant/operations/service-config";
import { fetchSellableCatalog } from "@/modules/restaurant/sales/pos.server";
import { createGuestOrder, recalcOrder, type SalesLineInput } from "@/modules/restaurant/sales/sales.server";
import { fireGuestOrder } from "@/modules/restaurant/kitchen/kitchen.server";
import {
  pickGuestOrderableLines,
  resolveGuestTableContext,
  resolveOrStartGuestSession,
} from "@/modules/restaurant/selforder/selforder.server";
import type { GuestLineInput } from "@/modules/restaurant/selforder/selforder.contracts";

type Db = any;

function safeOrderProjection(order: any, channel: string, orderType: string) {
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    status: order.status ?? "open",
    orderType,
    channel,
    currency: order.currency,
    subtotal: Number(order.subtotal ?? 0),
    taxTotal: Number(order.tax_total ?? 0),
    total: Number(order.total ?? 0),
    paidTotal: Number(order.paid_total ?? 0),
    paymentState: order.payment_state ?? "unpaid",
    idempotent: order.idempotent === true,
  };
}

/**
 * The single guest checkout write path for WhatsApp, website, social/direct
 * storefronts and table QR. The bearer token resolves all tenant scope;
 * client-supplied prices, tax, discounts, modifiers and order type are never
 * authoritative. All line pricing and station routing remains in insertLines.
 */
export async function submitGuestCommerceOrder(
  admin: Db,
  input: {
    token: string;
    guestName?: string;
    lines: GuestLineInput[];
    clientRequestId: string;
  },
) {
  const session = await resolveGuestCommerceSession(admin, input.token);
  if (!session) throw new Error("This Guest Commerce session has expired. Reopen the restaurant menu.");

  const [{ data: tenant, error: tenantError }, { data: property, error: propertyError }] =
    await Promise.all([
      admin.from("restaurant_tenants").select("id, status, settings").eq("id", session.tenantId).maybeSingle(),
      admin.from("restaurant_properties").select("id, status, currency, settings").eq("id", session.propertyId)
        .eq("tenant_id", session.tenantId).maybeSingle(),
    ]);
  if (tenantError || !tenant || tenant.status !== "active" ||
      propertyError || !property || property.status !== "active") {
    throw new Error("This restaurant ordering session is no longer available. Reopen the menu.");
  }
  if (String(property.currency ?? "").toUpperCase() !== session.currency) {
    throw new Error("The property currency has changed. Reopen the restaurant menu before ordering.");
  }

  const effectiveSettings = mergePropertyServiceSettings(tenant.settings, property.settings);
  const service = resolveServiceConfiguration(effectiveSettings);
  if (session.orderType === "room_service") {
    throw new Error("Room-service checkout requires a verified guest-room assignment.");
  }
  if (session.orderType === "takeaway" &&
      !["takeaway", "counter_service", "quick_service", "self_service"].includes(service.serviceMode)) {
    throw new Error("This outlet no longer accepts collection orders.");
  }
  if (session.orderType === "dine_in" && !session.tableId) {
    throw new Error("This outlet requires a table QR code before a dine-in order can be placed.");
  }

  let tableContext: Awaited<ReturnType<typeof resolveGuestTableContext>> | null = null;
  let guestSessionId: string | null = null;
  if (session.tableId) {
    tableContext = await resolveGuestTableContext(admin, session.tableId);
    if (
      tableContext.tenantId !== session.tenantId ||
      tableContext.propertyId !== session.propertyId ||
      tableContext.locationId !== session.locationId ||
      tableContext.currency !== session.currency
    ) {
      throw new Error("The table no longer matches this Guest Commerce session.");
    }
    const tableSession = await resolveOrStartGuestSession(admin, tableContext, null);
    guestSessionId = tableSession.sessionId;
  }

  const { data: existing, error: existingError } = await admin
    .from("restaurant_orders")
    .select("id, order_number, currency, status, payment_state, subtotal, tax_total, total, paid_total, guest_commerce_session_id, guest_commerce_channel, order_type")
    .eq("tenant_id", session.tenantId)
    .eq("client_request_id", input.clientRequestId)
    .maybeSingle();
  if (existingError) throw new Error("Unable to verify the previous order attempt.");
  if (existing) {
    if (existing.guest_commerce_session_id !== session.sessionId ||
        existing.guest_commerce_channel !== session.sourceChannel) {
      throw new Error("This order request has already been used. Refresh the menu and try again.");
    }
    return safeOrderProjection({ ...existing, idempotent: true }, session.sourceChannel, existing.order_type);
  }

  const catalog = await fetchSellableCatalog(admin, session.tenantId, {
    propertyId: session.propertyId,
    locationId: session.locationId,
    orderType: session.orderType,
  });
  const sellableIds = new Set(
    (catalog.items as any[])
      .filter((item) => item.is_available === true && item.priceConfigured === true)
      .map((item) => item.id as string),
  );
  const { valid, rejected } = pickGuestOrderableLines(sellableIds, input.lines);
  if (rejected.length) {
    throw new Error(`${rejected.length} item(s) are no longer available. Refresh the menu and try again.`);
  }
  if (!valid.length) throw new Error("The order has no orderable items.");

  const salesLines: SalesLineInput[] = valid.map((line) => ({
    menuItemId: line.menuItemId,
    variantId: line.variantId,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discount: line.discount,
    taxAmount: 0,
    notes: line.notes,
    guestNotes: line.guestNotes,
    modifiers: line.modifiers,
  }));

  const paymentTiming = resolveGuestPaymentTiming(effectiveSettings);
  const order = await createGuestOrder(admin, {
      tenantId: session.tenantId,
      propertyId: session.propertyId,
      locationId: session.locationId,
      tableId: session.tableId,
      orderType: session.orderType,
      source: "guest_commerce",
      guestCommerceSessionId: session.sessionId,
      guestCommerceChannel: session.sourceChannel,
      guestName: input.guestName ?? null,
      currency: session.currency,
      lines: salesLines,
      clientRequestId: input.clientRequestId,
      guestSessionId,
    });

  if (order.idempotent) {
    const { data: winner, error: winnerError } = await admin
      .from("restaurant_orders")
      .select("guest_commerce_session_id, guest_commerce_channel")
      .eq("id", order.id)
      .eq("tenant_id", session.tenantId)
      .maybeSingle();
    if (
      winnerError ||
      !winner ||
      winner.guest_commerce_session_id !== session.sessionId ||
      winner.guest_commerce_channel !== session.sourceChannel
    ) {
      throw new Error("This order request has already been used. Refresh the menu and try again.");
    }
  }

  if (!order.idempotent && paymentTiming === "pay_after_service") {
    await fireGuestOrder(admin, { tenantId: session.tenantId, orderId: order.id });
  }

  const refreshed = await recalcOrder(admin, session.tenantId, order.id);
  const { data: finalOrder, error: finalOrderError } = await admin
    .from("restaurant_orders")
    .select("id, order_number, status, payment_state, subtotal, tax_total, total, paid_total, currency")
    .eq("id", order.id)
    .eq("tenant_id", session.tenantId)
    .maybeSingle();
  if (finalOrderError || !finalOrder) throw new Error("The order was created but its confirmation is temporarily unavailable.");
  return safeOrderProjection(
    { ...finalOrder, ...refreshed, idempotent: order.idempotent },
    session.sourceChannel,
    session.orderType,
  );
}

/** Order lookup is capability-scoped to the exact session that placed it. */
export async function getGuestCommerceOrderStatus(
  admin: Db,
  input: { token: string; orderId: string },
) {
  const session = await resolveGuestCommerceSession(admin, input.token);
  if (!session) throw new Error("This Guest Commerce session has expired.");
  const { data: order, error } = await admin
    .from("restaurant_orders")
    .select("id, order_number, order_type, status, payment_state, subtotal, tax_total, total, paid_total, currency, opened_at")
    .eq("id", input.orderId)
    .eq("tenant_id", session.tenantId)
    .eq("property_id", session.propertyId)
    .eq("location_id", session.locationId)
    .eq("guest_commerce_session_id", session.sessionId)
    .maybeSingle();
  if (error || !order) throw new Error("This order could not be found for this Guest Commerce session.");
  const { data: items, error: itemsError } = await admin
    .from("restaurant_order_items")
    .select("id, description, quantity, line_total, status")
    .eq("tenant_id", session.tenantId)
    .eq("order_id", order.id);
  if (itemsError) throw new Error("Order progress is temporarily unavailable.");
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    orderType: order.order_type,
    status: order.status,
    paymentState: order.payment_state,
    subtotal: Number(order.subtotal ?? 0),
    taxTotal: Number(order.tax_total ?? 0),
    total: Number(order.total ?? 0),
    paidTotal: Number(order.paid_total ?? 0),
    currency: order.currency,
    openedAt: order.opened_at,
    items: (items ?? []).map((item: any) => ({
      description: item.description,
      quantity: Number(item.quantity),
      total: Number(item.line_total ?? 0),
      status: item.status,
    })),
  };
}
