/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * POS transactional core.
 *
 * The till is a terminal over the existing sales engine — it never owns its own
 * order model, pricing or costing. Every write here funnels into the same
 * `insertLines` / `recalcOrder` / `transitionOrder` path the admin order pad
 * uses, so a bill rung up at the bar and one typed in the back office are
 * indistinguishable to Finance, Inventory and the Intelligence Core.
 *
 * Two invariants the floor depends on:
 *  - Idempotency: a double-tapped "Open table" or "Take payment" is one order
 *    and one charge, enforced by a unique client request key in Postgres.
 *  - Evidence: voids, transfers and reopens are recorded with an actor and a
 *    reason; nothing money-affecting happens silently.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { reverseMovementsForOrderItem } from "../inventory/reversal.server";
import { REASON_CODES } from "../inventory/policy";
import { createOrder, insertLines, recalcOrder, transitionOrder, type SalesLineInput } from "./sales.server";
import type {
  AddPosLinesInput,
  OpenPosOrderInput,
  PosLineInput,
  PosPaymentInput,
  ReopenPosOrderInput,
  TransferPosOrderInput,
  VoidPosLineInput,
} from "./pos.contracts";

type Sb = any;

const OPEN_STATES = ["open", "sent", "served"];

/* ---------------- Reads ---------------- */

/**
 * Everything a till needs to paint the floor in one round trip: tables, the
 * live bill on each one, and the shift's running numbers.
 */
export async function posBoard(
  sb: Sb,
  userId: string,
  input: { tenantId: string; propertyId?: string; locationId?: string },
) {
  await assertTenantRead(sb, userId, input.tenantId);

  let tableQuery = sb
    .from("restaurant_tables")
    .select("id, code, name, zone, seats, status, active, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("active", true)
    .order("code");
  if (input.locationId) tableQuery = tableQuery.eq("location_id", input.locationId);

  let orderQuery = sb
    .from("restaurant_orders")
    .select(
      "id, order_number, order_type, status, payment_state, guest_count, guest_name, table_id, location_id, property_id, opened_at, closed_at, subtotal, total, paid_total, currency, terminal_id",
    )
    .eq("tenant_id", input.tenantId)
    .in("status", OPEN_STATES)
    .order("opened_at", { ascending: false })
    .limit(200);
  if (input.locationId) orderQuery = orderQuery.eq("location_id", input.locationId);

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const [{ data: tables }, { data: orders }, { data: today }] = await Promise.all([
    tableQuery,
    orderQuery,
    sb
      .from("restaurant_orders")
      .select("total, cost_total, guest_count, status")
      .eq("tenant_id", input.tenantId)
      .gte("opened_at", since.toISOString())
      .limit(1000),
  ]);

  const openOrders = (orders ?? []) as any[];
  const closedToday = ((today ?? []) as any[]).filter((o) => o.status === "closed");
  const revenue = closedToday.reduce((s, o) => s + Number(o.total ?? 0), 0);
  const covers = closedToday.reduce((s, o) => s + Number(o.guest_count ?? 0), 0);

  return {
    tables: ((tables ?? []) as any[]).map((t) => ({
      ...t,
      order: openOrders.find((o) => o.table_id === t.id) ?? null,
    })),
    openOrders,
    stats: {
      openBills: openOrders.length,
      openValue: Number(openOrders.reduce((s, o) => s + Number(o.total ?? 0), 0).toFixed(2)),
      revenueToday: Number(revenue.toFixed(2)),
      coversToday: covers,
      averageCheck: closedToday.length > 0 ? Number((revenue / closedToday.length).toFixed(2)) : 0,
    },
  };
}

/** Sellable catalogue for the till: menu items, their product/station mapping, variants and modifier groups. */
export async function posCatalog(
  sb: Sb,
  userId: string,
  input: { tenantId: string; propertyId?: string; locationId?: string; menuId?: string },
) {
  await assertTenantRead(sb, userId, input.tenantId);

  let menuQuery = sb
    .from("restaurant_menus")
    .select("id, name, status, currency, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("status", "published")
    .order("updated_at", { ascending: false });
  if (input.locationId) menuQuery = menuQuery.or(`location_id.is.null,location_id.eq.${input.locationId}`);
  const { data: menus } = await menuQuery;
  const menuIds = ((menus ?? []) as any[]).map((m) => m.id);
  const activeMenuId = input.menuId ?? menuIds[0] ?? null;

  const [{ data: categories }, { data: items }, { data: products }, { data: variants }, { data: groups }, { data: modifiers }, { data: links }] =
    await Promise.all([
      sb.from("restaurant_categories").select("id, name, slug, kind, sort_order").eq("tenant_id", input.tenantId).order("sort_order"),
      activeMenuId
        ? sb
            .from("restaurant_menu_items")
            .select("id, menu_id, category_id, name, description, price, currency, available, tags, allergens, sort_order")
            .eq("tenant_id", input.tenantId)
            .eq("menu_id", activeMenuId)
            .order("sort_order")
        : Promise.resolve({ data: [] }),
      sb
        .from("restaurant_products")
        .select("id, name, menu_item_id, station_id, price, product_type, active")
        .eq("tenant_id", input.tenantId)
        .eq("active", true),
      sb
        .from("restaurant_product_variants")
        .select("id, product_id, name, price, price_is_delta, active, sort_order")
        .eq("tenant_id", input.tenantId)
        .eq("active", true)
        .order("sort_order"),
      sb
        .from("restaurant_modifier_groups")
        .select("id, code, name, min_select, max_select, required, sort_order")
        .eq("tenant_id", input.tenantId)
        .eq("active", true)
        .order("sort_order"),
      sb
        .from("restaurant_modifiers")
        .select("id, group_id, name, price_delta, effect, sort_order")
        .eq("tenant_id", input.tenantId)
        .eq("active", true)
        .order("sort_order"),
      sb.from("restaurant_product_modifier_groups").select("product_id, group_id, sort_order").eq("tenant_id", input.tenantId),
    ]);

  const productByMenuItem = new Map<string, any>();
  for (const p of ((products ?? []) as any[])) if (p.menu_item_id) productByMenuItem.set(p.menu_item_id, p);

  const groupList = ((groups ?? []) as any[]).map((g) => ({
    ...g,
    modifiers: ((modifiers ?? []) as any[]).filter((m) => m.group_id === g.id),
  }));

  return {
    menus: menus ?? [],
    activeMenuId,
    categories: (categories ?? []).filter((c: any) => c.kind !== "inventory"),
    modifierGroups: groupList,
    items: ((items ?? []) as any[]).map((i) => {
      const product = productByMenuItem.get(i.id) ?? null;
      const groupIds = product
        ? ((links ?? []) as any[]).filter((l) => l.product_id === product.id).map((l) => l.group_id)
        : [];
      return {
        ...i,
        product_id: product?.id ?? null,
        station_id: product?.station_id ?? null,
        variants: product ? ((variants ?? []) as any[]).filter((v) => v.product_id === product.id) : [],
        modifier_group_ids: groupIds,
      };
    }),
  };
}

/* ---------------- Writes ---------------- */

function toSalesLines(lines: PosLineInput[]): SalesLineInput[] {
  return lines.map((l) => ({
    menuItemId: l.menuItemId,
    stationId: l.stationId,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discount: l.discount,
    taxAmount: 0,
    course: l.course,
    notes: l.notes,
    variantId: l.variantId,
    seatNumber: l.seatNumber,
    guestNotes: l.guestNotes,
    modifiers: l.modifiers,
  }));
}

/** Opens a bill. The same client request key always resolves to the same order. */
export async function openPosOrder(sb: Sb, userId: string, input: OpenPosOrderInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");

  const { data: existing } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, total, currency")
    .eq("tenant_id", input.tenantId)
    .eq("client_request_id", input.clientRequestId)
    .maybeSingle();
  if (existing) return { ...existing, idempotent: true };

  const order = await createOrder(sb, userId, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    tableId: input.tableId,
    servicePeriodId: input.servicePeriodId,
    orderType: input.orderType,
    guestCount: input.guestCount,
    guestName: input.guestName,
    bookingId: input.bookingId,
    currency: input.currency,
    source: "pos",
    lines: [],
  } as any);

  await sb
    .from("restaurant_orders")
    .update({ client_request_id: input.clientRequestId, terminal_id: input.terminalId ?? null })
    .eq("tenant_id", input.tenantId)
    .eq("id", order.id);

  if (input.lines.length > 0) {
    await addPosLines(sb, userId, { tenantId: input.tenantId, orderId: order.id, lines: input.lines });
  }
  const totals = await recalcOrder(sb, input.tenantId, order.id);
  return { ...order, ...totals, idempotent: false };
}

export async function addPosLines(sb: Sb, userId: string, input: AddPosLinesInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");

  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, currency, property_id, location_id, order_type, exchange_rate")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .single();
  if (!order) throw new Error("Order not found.");
  if (!OPEN_STATES.includes(order.status)) throw new Error("This bill is closed and can no longer be modified.");

  const inserted = await insertLines(sb, input.tenantId, input.orderId, toSalesLines(input.lines), {
    currency: order.currency ?? "TZS",
    propertyId: order.property_id,
    locationId: order.location_id,
    orderType: order.order_type,
    exchangeRate: Number(order.exchange_rate ?? 1),
    userId,
  });
  const totals = await recalcOrder(sb, input.tenantId, input.orderId);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.order.item.added",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: order.id,
    source: "restaurant-pos",
    payload: { order_number: order.order_number, lines: input.lines.length, order_total: Number(totals.total) },
  });
  return { items: inserted, order: totals };
}

/**
 * Voids a line. A line already fired to the kitchen keeps its ticket history —
 * the void is a correction on the record, never an erasure.
 *
 * If the line had already consumed stock (the bill was closed and later
 * reopened, or the line was room-charged), the consumption is unwound through
 * the ledger in the same operation: a void that leaves stock deducted is a
 * silent inventory loss, which is exactly what UAT-1 exists to stop.
 */
export async function voidPosLine(sb: Sb, userId: string, input: VoidPosLineInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.void");

  const { data: item } = await sb
    .from("restaurant_order_items")
    .select("id, order_id, description, quantity, line_total, line_cost, status")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderItemId)
    .single();
  if (!item || item.order_id !== input.orderId) throw new Error("Line not found on this bill.");
  if (item.status === "voided") throw new Error("This line is already voided.");

  // Ledger first: if the correction cannot be written, the line stays live and
  // the operator sees why, rather than money and stock disagreeing.
  const reversal = await reverseMovementsForOrderItem(sb, userId, {
    tenantId: input.tenantId,
    orderItemId: item.id,
    reason: `Line void: ${input.reason}`,
    reasonCode: REASON_CODES.saleReversal,
  });

  const { error } = await sb
    .from("restaurant_order_items")
    .update({
      status: "voided",
      void_reason: input.reason,
      voided_by: userId,
      voided_at: new Date().toISOString(),
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderItemId);
  if (error) throw new Error(error.message);

  const totals = await recalcOrder(sb, input.tenantId, input.orderId);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.order.item.voided",
    tenantId: input.tenantId,
    locationId: totals.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: input.orderId,
    source: "restaurant-pos",
    payload: {
      description: item.description,
      quantity: Number(item.quantity),
      value: Number(item.line_total ?? 0),
      reason: input.reason,
      stock_movements_reversed: reversal.reversed,
      stock_already_reversed: reversal.alreadyReversed,
      cost_restored: reversal.costRestored,
    },
    dedupeKey: `void:${item.id}`,
  });
  return { ...totals, reversal };
}

/** Moves a bill to another table (or off the floor) and keeps table states honest. */
export async function transferPosOrder(sb: Sb, userId: string, input: TransferPosOrderInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");

  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, table_id, location_id, property_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .single();
  if (!order) throw new Error("Order not found.");
  if (!OPEN_STATES.includes(order.status)) throw new Error("A closed bill cannot be transferred.");

  const patch: Record<string, unknown> = {};
  if (input.tableId !== undefined) patch.table_id = input.tableId;
  if (input.guestCount !== undefined) patch.guest_count = input.guestCount;

  const { data: updated, error } = await sb
    .from("restaurant_orders")
    .update(patch)
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .select("id, order_number, table_id, guest_count")
    .single();
  if (error) throw new Error(error.message);

  if (input.tableId !== undefined) {
    if (order.table_id && order.table_id !== input.tableId) {
      await sb.from("restaurant_tables").update({ status: "cleaning" }).eq("id", order.table_id).eq("tenant_id", input.tenantId);
    }
    if (input.tableId) {
      await sb.from("restaurant_tables").update({ status: "occupied" }).eq("id", input.tableId).eq("tenant_id", input.tenantId);
    }
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.order.transferred",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: order.id,
    source: "restaurant-pos",
    payload: { order_number: order.order_number, from_table: order.table_id, to_table: input.tableId ?? null, reason: input.reason ?? null },
  });
  return updated;
}

/**
 * Takes a payment. Split payments are simply several calls; the order settles
 * (and closes) only when the paid total reaches the bill.
 */
export async function takePosPayment(sb: Sb, userId: string, input: PosPaymentInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");

  const { data: duplicate } = await sb
    .from("restaurant_payments")
    .select("id, amount, method, state")
    .eq("tenant_id", input.tenantId)
    .eq("client_request_id", input.clientRequestId)
    .maybeSingle();

  if (!duplicate) {
    const { error } = await sb.from("restaurant_payments").insert({
      tenant_id: input.tenantId,
      order_id: input.orderId,
      client_request_id: input.clientRequestId,
      method: input.method,
      state: input.state,
      amount: input.amount,
      tendered: input.tendered ?? null,
      change_due:
        input.tendered != null ? Math.max(0, Number((input.tendered - input.amount).toFixed(2))) : 0,
      reference: input.reference ?? null,
      booking_id: input.bookingId ?? null,
      created_by: userId,
    });
    if (error) throw new Error(error.message);
  }

  let totals = await recalcOrder(sb, input.tenantId, input.orderId);
  if (input.state === "room_charged" || input.state === "comped") {
    await sb
      .from("restaurant_orders")
      .update({ payment_state: input.state })
      .eq("tenant_id", input.tenantId)
      .eq("id", input.orderId);
    totals = { ...totals, payment_state: input.state };
  }

  if (!duplicate) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.payment.captured",
      tenantId: input.tenantId,
      locationId: totals.location_id ?? undefined,
      entityType: "restaurant_order",
      entityId: input.orderId,
      source: "restaurant-pos",
      payload: { method: input.method, amount: input.amount, state: input.state, order_total: Number(totals.total) },
      dedupeKey: `pay:${input.clientRequestId}`,
    });
  }

  const settled = ["paid", "comped", "room_charged"].includes(String(totals.payment_state));
  let receipt: any = null;
  if (input.closeWhenSettled && settled && totals.status !== "closed") {
    // Closing is the commercial commit point: it consumes stock, posts actual
    // cost and freezes the receipt. It lives in the sales core, not here.
    await transitionOrder(sb, userId, { tenantId: input.tenantId, orderId: input.orderId, status: "closed" });
    const { getReceipt } = await import("./receipts.server");
    receipt = await getReceipt(sb, userId, { tenantId: input.tenantId, orderId: input.orderId });
    totals = await recalcOrder(sb, input.tenantId, input.orderId);
  }

  return { order: totals, settled, duplicate: Boolean(duplicate), receipt };
}

/** Reopens a closed bill for correction. Supervisor-only and always evidenced. */
export async function reopenPosOrder(sb: Sb, userId: string, input: ReopenPosOrderInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.reopen");

  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, location_id, property_id, table_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .single();
  if (!order) throw new Error("Order not found.");
  if (order.status !== "closed") throw new Error("Only a closed bill can be reopened.");

  const { data: updated, error } = await sb
    .from("restaurant_orders")
    .update({
      status: "served",
      closed_at: null,
      reopened_at: new Date().toISOString(),
      reopened_by: userId,
      reopen_reason: input.reason,
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .select("id, order_number, status")
    .single();
  if (error) throw new Error(error.message);

  if (order.table_id) {
    await sb.from("restaurant_tables").update({ status: "occupied" }).eq("id", order.table_id).eq("tenant_id", input.tenantId);
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.order.reopened",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: order.id,
    source: "restaurant-pos",
    payload: { order_number: order.order_number, reason: input.reason },
  });
  return updated;
}