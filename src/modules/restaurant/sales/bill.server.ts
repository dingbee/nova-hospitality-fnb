/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * The settlement half of the service lifecycle: bill requested → bill
 * presented → payment → receipt → delivered → table released.
 *
 * Two rules govern everything here:
 *   1. No figure is invented. Totals come from the order the kitchen actually
 *      served; splits only *divide* that total, never restate it.
 *   2. Every commercial fact is written down — who asked for the bill, when it
 *      was presented, how the receipt reached the guest, and why money went
 *      back — so a shift can always be reconstructed after the fact.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { add, money, sub } from "../pricing/decimal";
import { recalcOrder } from "./sales.server";
import type {
  BillStageInput,
  DeliverReceiptInput,
  GetBillInput,
  ListReceiptsInput,
  RefundPaymentInput,
} from "./bill.contracts";

type Sb = any;

const num = (v: unknown) => Number(v ?? 0);
const OPEN_STATES = ["open", "sent", "served"];

export type BillShare = { key: string; label: string; amount: number; lineIds: string[] };

/** Everything a server needs to present, split and settle one bill. */
export async function getBill(sb: Sb, userId: string, input: GetBillInput) {
  await assertTenantRead(sb, userId, input.tenantId);

  const [{ data: order }, { data: items }, { data: payments }, { data: receipt }] = await Promise.all([
    sb.from("restaurant_orders").select("*").eq("tenant_id", input.tenantId).eq("id", input.orderId).single(),
    sb
      .from("restaurant_order_items")
      .select(
        "id, description, quantity, unit_price, discount, tax_amount, service_charge_amount, modifiers, modifier_total, seat_number, course, line_total, status, guest_notes",
      )
      .eq("tenant_id", input.tenantId)
      .eq("order_id", input.orderId)
      .order("created_at"),
    sb
      .from("restaurant_payments")
      .select("id, method, state, amount, tendered, change_due, reference, refund_of, refund_reason, captured_at")
      .eq("tenant_id", input.tenantId)
      .eq("order_id", input.orderId)
      .order("captured_at"),
    sb
      .from("restaurant_receipts")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("order_id", input.orderId)
      .maybeSingle(),
  ]);
  if (!order) throw new Error("Order not found.");

  const all = (items ?? []) as any[];
  const lines = all.filter((i) => i.status !== "voided");
  const voided = all.filter((i) => i.status === "voided");
  const pays = (payments ?? []) as any[];

  const total = money(num(order.total));
  const paid = money(
    pays.filter((p) => p.state !== "refunded").reduce((s, p) => add(s, num(p.amount)), 0),
  );
  const refunded = money(
    pays.filter((p) => p.state === "refunded" && num(p.amount) < 0).reduce((s, p) => add(s, Math.abs(num(p.amount))), 0),
  );
  const balance = money(Math.max(0, sub(total, paid)));
  const changeGiven = money(pays.reduce((s, p) => add(s, num(p.change_due)), 0));

  return {
    order,
    lines,
    voidedLines: voided,
    payments: pays,
    receipt: receipt ?? null,
    totals: {
      currency: order.currency ?? "TZS",
      subtotal: money(num(order.subtotal)),
      discount: money(num(order.discount_total)),
      service: money(num(order.service_charge)),
      tax: money(num(order.tax_total)),
      total,
      paid,
      refunded,
      balance,
      changeGiven,
    },
    split: buildSplit(lines, total, balance, input.splitMode, input.ways),
    settled: balance <= 0 && ["paid", "comped", "room_charged"].includes(String(order.payment_state)),
    partiallyPaid: paid > 0 && balance > 0,
  };
}

/**
 * Splitting divides an existing total; it never recalculates tax or service.
 * Rounding remainders land on the first share so the parts always add up to
 * the bill, to the cent.
 */
export function buildSplit(
  lines: any[],
  total: number,
  balance: number,
  mode: GetBillInput["splitMode"],
  ways: number,
): { mode: string; shares: BillShare[]; reconciles: boolean } {
  let shares: BillShare[] = [];

  if (mode === "seat") {
    const groups = new Map<string, BillShare>();
    for (const l of lines) {
      const key = l.seat_number ? `seat-${l.seat_number}` : "shared";
      const label = l.seat_number ? `Seat ${l.seat_number}` : "Shared items";
      const existing = groups.get(key) ?? { key, label, amount: 0, lineIds: [] };
      existing.amount = add(existing.amount, num(l.line_total));
      existing.lineIds.push(l.id);
      groups.set(key, existing);
    }
    shares = [...groups.values()].map((s) => ({ ...s, amount: money(s.amount) }));
  } else if (mode === "even") {
    const per = money(total / ways);
    shares = Array.from({ length: ways }, (_, i) => ({
      key: `share-${i + 1}`,
      label: `Share ${i + 1} of ${ways}`,
      amount: per,
      lineIds: [],
    }));
    const drift = money(sub(total, money(per * ways)));
    if (drift !== 0 && shares[0]) shares[0].amount = money(add(shares[0].amount, drift));
  } else if (mode === "amount") {
    shares = [{ key: "balance", label: "Outstanding balance", amount: balance, lineIds: [] }];
  }

  const sum = money(shares.reduce((s, x) => add(s, x.amount), 0));
  return { mode, shares, reconciles: mode === "amount" || shares.length === 0 || sum === total };
}

/** The guest has asked for the bill. Recorded, so "we asked ages ago" is answerable. */
export async function requestBill(sb: Sb, userId: string, input: BillStageInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");
  const order = await liveOrder(sb, input.tenantId, input.orderId);
  if (order.bill_requested_at) return order;

  const { data: updated, error } = await sb
    .from("restaurant_orders")
    .update({ bill_requested_at: new Date().toISOString(), bill_requested_by: userId })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.bill.requested",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: order.id,
    source: "restaurant-pos",
    payload: { order_number: order.order_number, total: num(order.total), covers: order.guest_count },
    dedupeKey: `bill-requested:${order.id}`,
  });
  return updated;
}

/** The printed bill is now in front of the guest; the clock to payment starts here. */
export async function presentBill(sb: Sb, userId: string, input: BillStageInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");
  const order = await liveOrder(sb, input.tenantId, input.orderId);

  const now = new Date().toISOString();
  const { data: updated, error } = await sb
    .from("restaurant_orders")
    .update({ bill_presented_at: now, bill_requested_at: order.bill_requested_at ?? now })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.bill.presented",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: order.id,
    source: "restaurant-pos",
    payload: {
      order_number: order.order_number,
      total: num(order.total),
      waited_seconds: order.bill_requested_at
        ? Math.round((Date.parse(now) - Date.parse(order.bill_requested_at)) / 1000)
        : null,
    },
    dedupeKey: `bill-presented:${order.id}`,
  });
  return updated;
}

/** Turns the table over once the guest has left. Closing cleans; this frees. */
export async function releaseTable(sb: Sb, userId: string, input: { tenantId: string; orderId: string }) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");
  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, table_id, property_id, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .single();
  if (!order) throw new Error("Order not found.");
  if (order.status !== "closed") throw new Error("Settle and close the bill before releasing the table.");
  if (!order.table_id) return { released: false, reason: "This bill is not attached to a table." };

  await sb
    .from("restaurant_tables")
    .update({ status: "available" })
    .eq("id", order.table_id)
    .eq("tenant_id", input.tenantId);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.table.released",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_table",
    entityId: order.table_id,
    source: "restaurant-pos",
    payload: { order_number: order.order_number },
    dedupeKey: `table-released:${order.id}`,
  });
  return { released: true };
}

/**
 * Money back to a guest after settlement. The original payment is marked
 * refunded and a signed counter-entry is written, so the ledger shows both the
 * charge and its reversal rather than quietly deleting history.
 */
export async function refundPayment(sb: Sb, userId: string, input: RefundPaymentInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.void");

  const { data: duplicate } = await sb
    .from("restaurant_payments")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("client_request_id", input.clientRequestId)
    .maybeSingle();

  const { data: original } = await sb
    .from("restaurant_payments")
    .select("id, amount, method, state, order_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.paymentId)
    .single();
  if (!original) throw new Error("Payment not found.");
  if (original.order_id !== input.orderId) throw new Error("That payment belongs to a different bill.");
  if (input.amount > num(original.amount) + 0.001) {
    throw new Error("A refund cannot exceed the payment it reverses.");
  }

  if (!duplicate) {
    const { error } = await sb.from("restaurant_payments").insert({
      tenant_id: input.tenantId,
      order_id: input.orderId,
      client_request_id: input.clientRequestId,
      method: original.method,
      state: "refunded",
      amount: -Math.abs(input.amount),
      reference: `refund of ${original.id}`,
      refund_of: original.id,
      refund_reason: input.reason,
      created_by: userId,
    });
    if (error) throw new Error(error.message);
    await sb
      .from("restaurant_payments")
      .update({ state: "refunded", refund_reason: input.reason })
      .eq("tenant_id", input.tenantId)
      .eq("id", original.id);
  }

  const totals = await recalcOrder(sb, input.tenantId, input.orderId);

  if (!duplicate) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.payment.refunded",
      tenantId: input.tenantId,
      locationId: totals.location_id ?? undefined,
      entityType: "restaurant_order",
      entityId: input.orderId,
      source: "restaurant-pos",
      payload: { method: original.method, amount: input.amount, reason: input.reason },
      dedupeKey: `refund:${input.clientRequestId}`,
    });
  }
  return { order: totals, duplicate: Boolean(duplicate) };
}

/** Records how the receipt reached the guest. The receipt itself never changes. */
export async function deliverReceipt(sb: Sb, userId: string, input: DeliverReceiptInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");

  const { data: receipt } = await sb
    .from("restaurant_receipts")
    .select("id, receipt_number, property_id, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", input.orderId)
    .maybeSingle();
  if (!receipt) throw new Error("No receipt has been issued for this bill yet.");

  const { data: updated, error } = await sb
    .from("restaurant_receipts")
    .update({
      delivery_channel: input.channel,
      delivered_to: input.to ?? null,
      delivered_at: new Date().toISOString(),
    })
    .eq("id", receipt.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  const { recordDocumentEvent } = await import("../documents/audit/audit.server");
  await recordDocumentEvent(sb, userId, {
    tenantId: input.tenantId,
    documentType: "customer_receipt",
    documentId: receipt.id,
    documentNumber: receipt.receipt_number,
    action: input.channel === "print" ? "printed" : "emailed",
    format: input.channel === "print" ? "print" : "pdf",
    propertyId: receipt.property_id ?? null,
    locationId: receipt.location_id ?? null,
    metadata: { channel: input.channel, to: input.to ?? null },
  });

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.receipt.delivered",
    tenantId: input.tenantId,
    propertyId: receipt.property_id ?? undefined,
    locationId: receipt.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: input.orderId,
    source: "restaurant-pos",
    payload: { receipt_number: receipt.receipt_number, channel: input.channel },
  });
  return updated;
}

/** Receipt Centre lookup: by number, guest, or period. */
export async function listReceipts(sb: Sb, userId: string, input: ListReceiptsInput) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_receipts")
    .select(
      "id, order_id, receipt_number, currency, total, paid_total, issued_at, reprint_count, delivery_channel, delivered_to, delivered_at, snapshot",
    )
    .eq("tenant_id", input.tenantId)
    .order("issued_at", { ascending: false })
    .limit(input.limit);
  if (input.query.trim()) q = q.ilike("receipt_number", `%${input.query.trim()}%`);
  if (input.from) q = q.gte("issued_at", `${input.from}T00:00:00Z`);
  if (input.to) q = q.lte("issued_at", `${input.to}T23:59:59Z`);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    orderId: r.order_id,
    number: r.receipt_number,
    currency: r.currency,
    total: num(r.total),
    paid: num(r.paid_total),
    issuedAt: r.issued_at,
    reprints: Number(r.reprint_count ?? 0),
    deliveryChannel: r.delivery_channel ?? null,
    deliveredTo: r.delivered_to ?? null,
    deliveredAt: r.delivered_at ?? null,
    orderNumber: r.snapshot?.order?.number ?? null,
    guestName: r.snapshot?.order?.guest_name ?? null,
  }));
}

async function liveOrder(sb: Sb, tenantId: string, orderId: string) {
  const { data: order } = await sb
    .from("restaurant_orders")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .single();
  if (!order) throw new Error("Order not found.");
  if (!OPEN_STATES.includes(String(order.status))) {
    throw new Error(`Bill ${order.order_number} is ${order.status}; it cannot be presented again.`);
  }
  return order;
}