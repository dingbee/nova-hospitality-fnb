/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Staff side of the guest "Request staff" alert (restaurant_service_requests
 * — see migration 0006_guest_service_requests.sql and
 * ../selforder/selfstaff.server.ts for the guest-facing write). Read/write
 * here are staff-authenticated exactly like every other floor action in
 * this codebase (assertTenantRead / assertCapability, never RLS alone).
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import type { AcknowledgeServiceRequestInput } from "./service-requests.contracts";

type Sb = any;

export type ServiceRequestSummary = {
  id: string;
  tableId: string;
  orderId: string | null;
  requestType: string;
  status: "requested" | "acknowledged";
  requestedAt: string;
  acknowledgedAt: string | null;
};

function toSummary(row: any): ServiceRequestSummary {
  return {
    id: row.id,
    tableId: row.table_id,
    orderId: row.order_id ?? null,
    requestType: row.request_type,
    status: row.status,
    requestedAt: row.requested_at,
    acknowledgedAt: row.acknowledged_at ?? null,
  };
}

/**
 * Every currently-active ("requested") alert for a tenant — table, order,
 * request type, requested-at and current state, nothing more. This is what
 * pos.server.ts's posBoard attaches to each floor tile, reusing the board's
 * own already-polled query rather than a second polling loop.
 */
export async function listActiveServiceRequests(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_service_requests")
    .select("id, table_id, order_id, request_type, status, requested_at, acknowledged_at")
    .eq("tenant_id", tenantId)
    .eq("status", "requested")
    .order("requested_at", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as any[]).map(toSummary);
}

/**
 * Requested → Acknowledged. Idempotent: acknowledging an already-acknowledged
 * request (a second staff member taps the same alert) is a no-op read, not
 * a second write or a second event — mirrors requestBill/presentBill's own
 * "already in this state, return it" pattern in bill.server.ts.
 */
export async function acknowledgeServiceRequest(
  sb: Sb,
  userId: string,
  input: AcknowledgeServiceRequestInput,
): Promise<ServiceRequestSummary> {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");

  const { data: existing } = await sb
    .from("restaurant_service_requests")
    .select(
      "id, table_id, order_id, request_type, status, requested_at, acknowledged_at, property_id, location_id",
    )
    .eq("tenant_id", input.tenantId)
    .eq("id", input.requestId)
    .maybeSingle();
  if (!existing) throw new Error("Request not found.");
  if (existing.status === "acknowledged") return toSummary(existing);

  const now = new Date().toISOString();
  const { data: updated, error } = await sb
    .from("restaurant_service_requests")
    .update({ status: "acknowledged", acknowledged_at: now, acknowledged_by: userId })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.requestId)
    .select("id, table_id, order_id, request_type, status, requested_at, acknowledged_at")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.service_request.acknowledged",
    tenantId: input.tenantId,
    propertyId: existing.property_id ?? undefined,
    locationId: existing.location_id ?? undefined,
    entityType: "restaurant_order",
    entityId: existing.order_id ?? existing.table_id,
    source: "restaurant-pos",
    payload: {
      table_id: existing.table_id,
      order_id: existing.order_id,
      request_type: existing.request_type,
    },
    dedupeKey: `service-request-acknowledged:${input.requestId}`,
  });

  return toSummary(updated);
}
