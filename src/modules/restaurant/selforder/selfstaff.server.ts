/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Guest "Request staff" — the first live guest-to-staff alert. Table+order
 * scoped through the same resolveGuestTableContext boundary as every other
 * guest function in this module; nothing about tenant/property/location/
 * request status/timestamps/staff identity is ever accepted from the
 * client. Writes go to restaurant_service_requests (see migration
 * 0006_guest_service_requests.sql) — a small, generic table rather than a
 * second bill_requested_at-style pair of order columns, so a later phase
 * can add another guest alert type without a new table.
 *
 * Spam control is two-layered: this module only ever inserts when no
 * "requested" row already exists for the order (checked below), and the
 * database itself enforces the same rule with a unique partial index, so a
 * genuine double-tap race still can't create two active alerts.
 */
import { resolveGuestTableContext } from "./selforder.server";

type Sb = any;

const STAFF_REQUEST_ORDER_STATUSES = new Set(["open", "sent", "served"]);
const REQUEST_TYPE = "assistance";

/** Table + order scoped exactly like loadGuestOrder in selfbill.server.ts / selfpay.server.ts. */
async function loadGuestOrderForStaffRequest(
  sb: Sb,
  tenantId: string,
  tableId: string,
  orderId: string,
) {
  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .eq("table_id", tableId)
    .maybeSingle();
  if (!order) throw new Error("Order not found for this table.");
  return order;
}

type RequestRow = { status: string; requested_at: string; acknowledged_at: string | null };

async function latestStaffRequest(
  sb: Sb,
  tenantId: string,
  orderId: string,
): Promise<RequestRow | null> {
  const { data } = await sb
    .from("restaurant_service_requests")
    .select("status, requested_at, acknowledged_at")
    .eq("tenant_id", tenantId)
    .eq("order_id", orderId)
    .eq("request_type", REQUEST_TYPE)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RequestRow | null) ?? null;
}

export type StaffRequestState =
  | { status: "none" }
  | { status: "requested"; requestedAt: string; acknowledgedAt: null }
  | { status: "acknowledged"; requestedAt: string; acknowledgedAt: string };

function toState(row: RequestRow | null): StaffRequestState {
  if (!row) return { status: "none" };
  if (row.status === "acknowledged") {
    return {
      status: "acknowledged",
      requestedAt: row.requested_at,
      acknowledgedAt: row.acknowledged_at as string,
    };
  }
  return { status: "requested", requestedAt: row.requested_at, acknowledgedAt: null };
}

export type RequestStaffResult =
  | ({ ok: true } & StaffRequestState)
  | { ok: false; reason: "not_requestable"; orderStatus: string };

/**
 * Idempotent by construction, mirroring requestGuestBill: an active
 * ("requested") alert for this order is returned as-is rather than
 * duplicated — the guest tapping "Request staff" again before anyone has
 * acknowledged never creates a second alert. Once acknowledged, a further
 * tap starts a genuinely new request (the guest may need help again).
 */
export async function requestStaff(
  sb: Sb,
  input: { tableId: string; orderId: string },
): Promise<RequestStaffResult> {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrderForStaffRequest(
    sb,
    table.tenantId,
    input.tableId,
    input.orderId,
  );

  const existing = await latestStaffRequest(sb, table.tenantId, order.id);
  if (existing && existing.status === "requested") {
    return { ok: true, ...toState(existing) };
  }
  if (!STAFF_REQUEST_ORDER_STATUSES.has(order.status)) {
    return { ok: false, reason: "not_requestable", orderStatus: order.status };
  }

  const now = new Date().toISOString();
  const { data: inserted, error } = await sb
    .from("restaurant_service_requests")
    .insert({
      tenant_id: table.tenantId,
      property_id: table.propertyId,
      location_id: table.locationId,
      table_id: table.tableId,
      order_id: order.id,
      request_type: REQUEST_TYPE,
      status: "requested",
      requested_at: now,
    })
    .select("status, requested_at, acknowledged_at")
    .single();

  if (error) {
    // A concurrent tap already won the race and inserted the active row
    // (the database's own one-active-request-per-order index) — read back
    // what exists rather than surfacing this as a failure to the guest.
    if (String(error.code) === "23505") {
      const raced = await latestStaffRequest(sb, table.tenantId, order.id);
      if (raced) return { ok: true, ...toState(raced) };
    }
    throw new Error(error.message);
  }

  return { ok: true, ...toState(inserted as RequestRow) };
}

/**
 * Read-only — polled by the guest screen to observe "Requested" become
 * "Staff acknowledged" without re-triggering a request (unlike
 * requestStaff, this never inserts).
 */
export async function guestStaffRequestStatus(
  sb: Sb,
  input: { tableId: string; orderId: string },
): Promise<{ ok: true } & StaffRequestState> {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrderForStaffRequest(
    sb,
    table.tenantId,
    input.tableId,
    input.orderId,
  );
  const existing = await latestStaffRequest(sb, table.tenantId, order.id);
  return { ok: true, ...toState(existing) };
}
