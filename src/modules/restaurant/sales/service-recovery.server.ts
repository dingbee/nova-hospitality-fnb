/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import type { ServiceRecoveryInput } from "./service-recovery.contracts";

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
