/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Receipts — the immutable evidence of a settled bill.
 *
 * A receipt is a snapshot, not a view: it stores the lines, taxes, charges and
 * payments exactly as they stood at close. Later price, recipe or tax changes
 * can never rewrite a receipt that a guest already holds. Reprints increment a
 * counter instead of producing a second document.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { operatorMessageForState, type FiscalStatusView } from "../fiscal/contracts";

type Sb = any;

/**
 * Fiscalization is best-effort and must never fail a receipt: a payment
 * already succeeded by the time a receipt is issued, and fiscal status is a
 * separate truth layered on top (spec section 14). Any error here — no
 * fiscal configuration, provider unreachable, adapter throwing — degrades to
 * "pending", never blocks the receipt or rethrows to the cashier.
 */
async function attachFiscalStatus(
  sb: Sb,
  userId: string,
  input: { tenantId: string; orderId: string; restaurantReceiptId: string },
): Promise<FiscalStatusView> {
  try {
    const { requestFiscalization } = await import("../fiscal/fiscal.server");
    return await requestFiscalization(sb, userId, input);
  } catch (err) {
    console.error("[restaurant-fiscal] fiscalization request failed — receipt still issued", err);
    return {
      state: "pending",
      operatorMessage: operatorMessageForState("pending"),
      fiscalReceiptNumber: null,
      verificationCode: null,
      zNumber: null,
      fiscalizedAt: null,
      environment: null,
    };
  }
}

export async function issueReceipt(
  sb: Sb,
  userId: string,
  input: { tenantId: string; orderId: string; reprint?: boolean },
) {
  // Fiscalization (requestFiscalization, called below via attachFiscalStatus)
  // deliberately never checks capability itself — it trusts that whoever can
  // reach it already passed an authorized, scope-checked sales flow. This is
  // that check: it must be scoped to the order's own property/location, not
  // just the tenant, since a receipt/fiscal request for one property's order
  // must not be reachable by staff scoped to a different property.
  const { data: orderScope } = await sb
    .from("restaurant_orders")
    .select("property_id, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .maybeSingle();
  await assertCapability(sb, userId, input.tenantId, "sales.manage", {
    propertyId: orderScope?.property_id ?? null,
    locationId: orderScope?.location_id ?? null,
  });

  const { data: existing } = await sb
    .from("restaurant_receipts")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", input.orderId)
    .maybeSingle();

  if (existing) {
    const fiscal = await attachFiscalStatus(sb, userId, {
      tenantId: input.tenantId,
      orderId: input.orderId,
      restaurantReceiptId: existing.id,
    });
    if (!input.reprint) return { ...existing, fiscal };
    const { data: reprinted } = await sb
      .from("restaurant_receipts")
      .update({ reprint_count: Number(existing.reprint_count ?? 0) + 1 })
      .eq("id", existing.id)
      .select("*")
      .single();
    return { ...(reprinted ?? existing), fiscal };
  }

  const [{ data: order }, { data: items }, { data: payments }] = await Promise.all([
    sb
      .from("restaurant_orders")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.orderId)
      .single(),
    sb
      .from("restaurant_order_items")
      .select(
        "id, description, quantity, unit_price, discount, tax_amount, service_charge_amount, modifiers, modifier_total, seat_number, line_total, line_cost, status, price_source, tax_rate",
      )
      .eq("tenant_id", input.tenantId)
      .eq("order_id", input.orderId)
      .order("created_at"),
    sb
      .from("restaurant_payments")
      .select("id, method, state, amount, tendered, change_due, reference, captured_at")
      .eq("tenant_id", input.tenantId)
      .eq("order_id", input.orderId)
      .order("captured_at"),
  ]);
  if (!order) throw new Error("Order not found.");

  const { data: numbered, error: numberError } = await sb.rpc("restaurant_next_document_number", {
    _tenant: input.tenantId,
    _doc_type: "receipt",
    _prefix: "RCP",
  });
  const receiptNumber =
    numberError || !numbered
      ? `RCP-${String(order.order_number ?? order.id).slice(-10)}`
      : numbered;

  const live = ((items ?? []) as any[]).filter((i) => i.status !== "voided");
  const snapshot = {
    order: {
      id: order.id,
      number: order.order_number,
      type: order.order_type,
      table_id: order.table_id,
      guest_count: order.guest_count,
      guest_name: order.guest_name,
      opened_at: order.opened_at,
      closed_at: order.closed_at,
      terminal_id: order.terminal_id ?? null,
      exchange_rate: Number(order.exchange_rate ?? 1),
      base_currency: order.base_currency ?? null,
    },
    lines: live,
    voided_lines: ((items ?? []) as any[]).filter((i) => i.status === "voided"),
    payments: payments ?? [],
    issued_at: new Date().toISOString(),
  };

  const { data: receipt, error } = await sb
    .from("restaurant_receipts")
    .insert({
      tenant_id: input.tenantId,
      property_id: order.property_id ?? null,
      location_id: order.location_id ?? null,
      order_id: order.id,
      receipt_number: receiptNumber,
      currency: order.currency ?? "TZS",
      subtotal: Number(order.subtotal ?? 0),
      discount_total: Number(order.discount_total ?? 0),
      tax_total: Number(order.tax_total ?? 0),
      service_charge: Number(order.service_charge ?? 0),
      total: Number(order.total ?? 0),
      paid_total: Number(order.paid_total ?? 0),
      cost_total: Number(order.cost_total ?? 0),
      snapshot,
      issued_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.receipt.issued",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: order.id,
    source: "restaurant-pos",
    payload: { receipt_number: receiptNumber, total: Number(order.total ?? 0) },
    dedupeKey: `receipt:${order.id}`,
  });

  const fiscal = await attachFiscalStatus(sb, userId, {
    tenantId: input.tenantId,
    orderId: input.orderId,
    restaurantReceiptId: receipt.id,
  });
  return { ...receipt, fiscal };
}

export async function getReceipt(
  sb: Sb,
  userId: string,
  input: { tenantId: string; orderId: string },
) {
  const { data: orderScope } = await sb
    .from("restaurant_orders")
    .select("property_id, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .maybeSingle();
  await assertTenantRead(sb, userId, input.tenantId, {
    propertyId: orderScope?.property_id ?? null,
    locationId: orderScope?.location_id ?? null,
  });
  const { data } = await sb
    .from("restaurant_receipts")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", input.orderId)
    .maybeSingle();
  if (!data) return null;

  const { getFiscalStatusForOrder } = await import("../fiscal/fiscal.server");
  const fiscal = await getFiscalStatusForOrder(sb, userId, {
    tenantId: input.tenantId,
    orderId: input.orderId,
  }).catch(() => null);
  return { ...data, fiscal };
}
