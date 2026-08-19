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

type Sb = any;

export async function issueReceipt(
  sb: Sb,
  userId: string,
  input: { tenantId: string; orderId: string; reprint?: boolean },
) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");

  const { data: existing } = await sb
    .from("restaurant_receipts")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", input.orderId)
    .maybeSingle();

  if (existing) {
    if (!input.reprint) return existing;
    const { data: reprinted } = await sb
      .from("restaurant_receipts")
      .update({ reprint_count: Number(existing.reprint_count ?? 0) + 1 })
      .eq("id", existing.id)
      .select("*")
      .single();
    return reprinted ?? existing;
  }

  const [{ data: order }, { data: items }, { data: payments }] = await Promise.all([
    sb.from("restaurant_orders").select("*").eq("tenant_id", input.tenantId).eq("id", input.orderId).single(),
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

  let receiptNumber: string;
  const { data: numbered, error: numberError } = await sb.rpc("restaurant_next_document_number", {
    _tenant: input.tenantId,
    _doc_type: "receipt",
    _prefix: "RCP",
  });
  receiptNumber = numberError || !numbered ? `RCP-${String(order.order_number ?? order.id).slice(-10)}` : numbered;

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
  return receipt;
}

export async function getReceipt(sb: Sb, userId: string, input: { tenantId: string; orderId: string }) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data } = await sb
    .from("restaurant_receipts")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", input.orderId)
    .maybeSingle();
  return data ?? null;
}