/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import type { ServiceRecoveryInput, ServiceRecoveryResolutionInput } from "./service-recovery.contracts";
import { refundPayment } from "./bill.server";
import { addPosLines, voidPosLine } from "./pos.server";
import { compOrderItem } from "../bar/bar.server";

type Sb = any;

export async function listServiceRecoveryCases(sb: Sb, userId: string, input: { tenantId: string; propertyId?: string; limit: number }) {
  await assertTenantRead(sb, userId, input.tenantId, { propertyId: input.propertyId ?? null });
  let query = sb.from("restaurant_service_recovery_cases").select("*").eq("tenant_id", input.tenantId).order("created_at", { ascending: false }).limit(input.limit);
  if (input.propertyId) query = query.eq("property_id", input.propertyId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Records a tenant-scoped complaint. It does not impersonate POS, refund,
 * comp, replacement or inventory workflows; those actions remain canonical.
 */
export async function recordServiceRecovery(sb: Sb, userId: string, input: ServiceRecoveryInput) {
  const { data: order, error: orderError } = await sb.from("restaurant_orders")
    .select("id, order_number, status, property_id, location_id")
    .eq("tenant_id", input.tenantId).eq("id", input.orderId).maybeSingle();
  if (orderError) throw new Error(orderError.message);
  if (!order) throw new Error("Order not found in this tenant.");

  await assertCapability(sb, userId, input.tenantId, "sales.void", {
    propertyId: order.property_id ?? null, locationId: order.location_id ?? null,
  });

  const { data: original, error: itemError } = await sb.from("restaurant_order_items")
    .select("id, order_id, status, description, quantity, line_total")
    .eq("tenant_id", input.tenantId).eq("id", input.originalOrderItemId).maybeSingle();
  if (itemError) throw new Error(itemError.message);
  if (!original || original.order_id !== order.id) throw new Error("Original line not found on this order.");

  const prepared = ["fired", "sent", "preparing", "ready", "served"].includes(String(original.status));
  const expectedDisposition = prepared ? "preserve_consumption" : "reverse_unprepared";
  if (input.stockDisposition !== expectedDisposition && input.stockDisposition !== "wastage_review" && input.stockDisposition !== "not_applicable") {
    throw new Error("Stock disposition conflicts with the original line's production state.");
  }
  if (input.resolution !== "pending") {
    throw new Error("Service recovery intake only records open cases. Complete financial/production actions in their canonical workflows, then close the case through the approved resolution workflow.");
  }

  const row = {
    tenant_id: input.tenantId, property_id: order.property_id ?? null, location_id: order.location_id ?? null,
    order_id: order.id, original_order_item_id: original.id,
    replacement_order_item_id: null, refund_payment_id: null,
    client_request_id: input.clientRequestId, complaint_category: input.complaintCategory,
    complaint: input.complaint.trim(), resolution: "pending",
    resolution_reason: input.resolutionReason.trim(), status: "open",
    stock_disposition: input.stockDisposition, reported_by: userId,
    resolved_by: null, resolved_at: null, updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb.from("restaurant_service_recovery_cases").insert(row).select("*").single();
  if (error) {
    if (String(error.code) === "23505") {
      const { data: existing, error: lookupError } = await sb.from("restaurant_service_recovery_cases").select("*")
        .eq("tenant_id", input.tenantId).eq("client_request_id", input.clientRequestId).maybeSingle();
      if (lookupError) throw new Error(lookupError.message);
      if (existing) {
        const sameRequest = existing.order_id === input.orderId &&
          existing.original_order_item_id === input.originalOrderItemId &&
          existing.complaint_category === input.complaintCategory &&
          existing.complaint === input.complaint.trim();
        if (!sameRequest) throw new Error("This request ID was already used for a different service-recovery case.");
        return { ...existing, idempotent: true };
      }
    }
    throw new Error(error.message);
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.service_recovery.recorded", tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined, locationId: order.location_id ?? undefined,
    entityType: "restaurant_service_recovery_case", entityId: data.id, source: "restaurant-pos",
    payload: {
      order_id: order.id, order_number: order.order_number, original_order_item_id: original.id,
      original_description: original.description, complaint_category: input.complaintCategory,
      resolution: "pending", stock_disposition: input.stockDisposition,
      value_at_report: Number(original.line_total ?? 0),
    },
    dedupeKey: `service-recovery:${input.tenantId}:${input.clientRequestId}`,
  });
  return { ...data, idempotent: false };
}


/** Execute a recovery through canonical POS/refund/comp workflows and close the case. */
export async function resolveServiceRecovery(sb: Sb, userId: string, input: ServiceRecoveryResolutionInput) {
  const { data: recovery, error: recoveryError } = await sb.from("restaurant_service_recovery_cases")
    .select("*").eq("tenant_id", input.tenantId).eq("id", input.caseId).maybeSingle();
  if (recoveryError) throw new Error(recoveryError.message);
  if (!recovery) throw new Error("Service-recovery case not found.");
  if (recovery.status === "resolved") {
    if (recovery.resolution === input.resolution && recovery.resolution_reason === input.reason.trim()) return { ...recovery, idempotent: true };
    throw new Error("This case is already resolved with a different outcome.");
  }
  const { data: order, error: orderError } = await sb.from("restaurant_orders")
    .select("id, property_id, location_id").eq("tenant_id", input.tenantId).eq("id", recovery.order_id).maybeSingle();
  if (orderError) throw new Error(orderError.message);
  if (!order) throw new Error("The recovery order no longer exists.");
  await assertCapability(sb, userId, input.tenantId, "sales.void", { propertyId: order.property_id ?? null, locationId: order.location_id ?? null });

  let replacementOrderItemId: string | null = recovery.replacement_order_item_id ?? null;
  let refundPaymentId: string | null = recovery.refund_payment_id ?? null;
  let stockDisposition = String(recovery.stock_disposition);
  const reason = input.reason.trim();

  if (input.resolution === "replace") {
    const { data: line, error } = await sb.from("restaurant_order_items")
      .select("id, menu_item_id, variant_id, station_id, description, quantity, unit_price, discount, seat_number, course, guest_notes, status")
      .eq("tenant_id", input.tenantId).eq("id", recovery.original_order_item_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!line) throw new Error("Original order item not found; case remains open.");
    const result = await addPosLines(sb, userId, {
      tenantId: input.tenantId, orderId: recovery.order_id, clientRequestId: "recovery-replace-" + recovery.id,
      lines: [{
        menuItemId: line.menu_item_id ?? undefined, variantId: line.variant_id ?? undefined,
        stationId: line.station_id ?? undefined, description: line.description,
        quantity: Number(line.quantity ?? 1), unitPrice: Number(line.unit_price ?? 0),
        discount: Number(line.discount ?? 0), seatNumber: line.seat_number ?? undefined,
        course: line.course ?? undefined, guestNotes: line.guest_notes ?? undefined,
        notes: "Service recovery replacement: " + reason, modifiers: [],
      }],
    } as any);
    replacementOrderItemId = result.items?.[0]?.id ?? replacementOrderItemId;
    if (!replacementOrderItemId) throw new Error("Replacement line was not confirmed; case remains open.");
    if (["fired", "sent", "preparing", "ready", "served"].includes(String(line.status))) stockDisposition = "preserve_consumption";
  } else if (input.resolution === "comp") {
    await assertCapability(sb, userId, input.tenantId, "sales.discount", { propertyId: order.property_id ?? null, locationId: order.location_id ?? null });
    await compOrderItem(sb, userId, { tenantId: input.tenantId, orderItemId: recovery.original_order_item_id, reason, comp: true });
  } else if (input.resolution === "refund") {
    if (!input.paymentId || !input.amount || input.amount <= 0) throw new Error("Select the settled payment and a positive refund amount.");
    await refundPayment(sb, userId, {
      tenantId: input.tenantId, orderId: recovery.order_id, paymentId: input.paymentId,
      amount: input.amount, reason, clientRequestId: "recovery-refund-" + recovery.id,
    });
    const { data: refundRow, error } = await sb.from("restaurant_payments").select("id")
      .eq("tenant_id", input.tenantId).eq("order_id", recovery.order_id)
      .eq("client_request_id", "recovery-refund-" + recovery.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!refundRow) throw new Error("Refund was not confirmed in the payment ledger; case remains open.");
    refundPaymentId = refundRow.id;
  } else if (input.resolution === "void_unprepared") {
    const { data: line, error } = await sb.from("restaurant_order_items").select("id, status, void_reason")
      .eq("tenant_id", input.tenantId).eq("id", recovery.original_order_item_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!line) throw new Error("Original order item not found; case remains open.");
    if (line.status === "voided") {
      if (String(line.void_reason ?? "") !== reason) throw new Error("The line is already voided for a different reason.");
    } else {
      if (["fired", "sent", "preparing", "ready", "served"].includes(String(line.status))) throw new Error("Prepared/served items cannot use unprepared void; stock consumption must be preserved.");
      await voidPosLine(sb, userId, { tenantId: input.tenantId, orderId: recovery.order_id, orderItemId: line.id, reason });
    }
    stockDisposition = "reverse_unprepared";
  }

  const { data: closed, error: closeError } = await sb.from("restaurant_service_recovery_cases").update({
    resolution: input.resolution, resolution_reason: reason, status: "resolved",
    replacement_order_item_id: replacementOrderItemId, refund_payment_id: refundPaymentId,
    stock_disposition: stockDisposition, resolved_by: userId, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("tenant_id", input.tenantId).eq("id", recovery.id).eq("status", "open").select("*").maybeSingle();
  if (closeError) throw new Error(closeError.message);
  if (!closed) {
    const { data: current } = await sb.from("restaurant_service_recovery_cases").select("*").eq("tenant_id", input.tenantId).eq("id", recovery.id).maybeSingle();
    if (current?.status === "resolved" && current?.resolution === input.resolution && current?.resolution_reason === reason) return { ...current, idempotent: true };
    throw new Error("Recovery action ran but closure was not confirmed. Reconcile the action ledger before retrying.");
  }
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.service_recovery.recorded", tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined, locationId: order.location_id ?? undefined,
    entityType: "restaurant_service_recovery_case", entityId: recovery.id, source: "restaurant-pos",
    payload: { order_id: order.id, resolution: input.resolution, reason, stock_disposition: stockDisposition, status: "resolved" },
    dedupeKey: "service-recovery-resolved:" + recovery.id,
  });
  return { ...closed, idempotent: false };
}
