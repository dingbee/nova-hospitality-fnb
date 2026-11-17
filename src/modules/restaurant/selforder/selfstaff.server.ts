/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Guest "Request staff" — the first live guest-to-staff alert. Table+order
 * scoped through the same resolveGuestTableContext boundary as every other
 * guest function in this module; nothing about tenant/property/location/
 * request status/timestamps/staff identity is ever accepted from the
 * client. Writes go to restaurant_service_requests (see migration
 * 0006_guest_service_requests.sql, extended by
 * 0042_service_request_lifecycle_and_cooldown.sql) — a small, generic table
 * rather than a second bill_requested_at-style pair of order columns, so a
 * later phase can add another guest alert type without a new table.
 *
 * Full lifecycle: AVAILABLE -> REQUESTED -> ACKNOWLEDGED -> RESOLVED ->
 * COOLDOWN -> AVAILABLE. "Cooldown" is never a stored status — it is
 * derived, here, from resolved_at plus the tenant's configured (or
 * default) cooldown window, so the server is the one place that ever
 * decides whether a guest may request again. canRequestStaff() is that one
 * decision point; every function below goes through it rather than
 * re-deriving availability itself.
 *
 * Spam control is two-layered: this module only ever inserts when
 * canRequestStaff() says AVAILABLE, and the database itself enforces "at
 * most one non-resolved request per order" with a unique partial index, so
 * a genuine double-tap race still can't create two active alerts.
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

type RequestRow = {
  status: string;
  requested_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
};

async function latestStaffRequest(
  sb: Sb,
  tenantId: string,
  orderId: string,
): Promise<RequestRow | null> {
  const { data } = await sb
    .from("restaurant_service_requests")
    .select("status, requested_at, acknowledged_at, resolved_at")
    .eq("tenant_id", tenantId)
    .eq("order_id", orderId)
    .eq("request_type", REQUEST_TYPE)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RequestRow | null) ?? null;
}

export type StaffRequestState =
  | { status: "available" }
  | { status: "requested"; requestedAt: string }
  | { status: "acknowledged"; requestedAt: string; acknowledgedAt: string }
  | {
      status: "cooldown";
      resolvedAt: string;
      cooldownEndsAt: string;
      cooldownRemainingSeconds: number;
    };

/**
 * The one place "can this guest request staff right now" is decided.
 * `now` is a parameter (not read internally) purely so tests can pin it —
 * every real caller passes `new Date()`.
 */
function evaluateState(
  row: RequestRow | null,
  cooldownSeconds: number,
  now: Date,
): { canRequest: boolean; state: StaffRequestState } {
  if (!row) return { canRequest: true, state: { status: "available" } };

  if (row.status === "requested") {
    return { canRequest: false, state: { status: "requested", requestedAt: row.requested_at } };
  }

  if (row.status === "acknowledged") {
    return {
      canRequest: false,
      state: {
        status: "acknowledged",
        requestedAt: row.requested_at,
        acknowledgedAt: row.acknowledged_at as string,
      },
    };
  }

  // status === "resolved" — the only state a fresh request can ever follow.
  const resolvedAt = row.resolved_at as string;
  const cooldownEndsAt = new Date(new Date(resolvedAt).getTime() + cooldownSeconds * 1000);
  if (now.getTime() >= cooldownEndsAt.getTime()) {
    return { canRequest: true, state: { status: "available" } };
  }
  const cooldownRemainingSeconds = Math.ceil((cooldownEndsAt.getTime() - now.getTime()) / 1000);
  return {
    canRequest: false,
    state: {
      status: "cooldown",
      resolvedAt,
      cooldownEndsAt: cooldownEndsAt.toISOString(),
      cooldownRemainingSeconds,
    },
  };
}

export type RequestStaffResult =
  | ({ ok: true } & StaffRequestState)
  | { ok: false; reason: "not_requestable"; orderStatus: string };

/**
 * Idempotent by construction: if a request is already active (requested or
 * acknowledged) or the guest is still within cooldown, this returns the
 * current state as-is rather than inserting anything — a double tap,
 * refresh-then-tap, or a second browser tab all resolve to the same read,
 * never a second row. Only a genuine AVAILABLE state ever gets a new insert.
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
  const now = new Date();
  const { canRequest, state } = evaluateState(existing, table.serviceRequestCooldownSeconds, now);
  if (!canRequest) {
    return { ok: true, ...state };
  }
  if (!STAFF_REQUEST_ORDER_STATUSES.has(order.status)) {
    return { ok: false, reason: "not_requestable", orderStatus: order.status };
  }

  const nowIso = now.toISOString();
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
      requested_at: nowIso,
    })
    .select("status, requested_at, acknowledged_at, resolved_at")
    .single();

  if (error) {
    // A concurrent tap already won the race and inserted the active row
    // (the database's own one-active-request-per-order index) — read back
    // what exists rather than surfacing this as a failure to the guest.
    if (String(error.code) === "23505") {
      const raced = await latestStaffRequest(sb, table.tenantId, order.id);
      const reevaluated = evaluateState(raced, table.serviceRequestCooldownSeconds, new Date());
      return { ok: true, ...reevaluated.state };
    }
    throw new Error(error.message);
  }

  return {
    ok: true,
    ...evaluateState(inserted as RequestRow, table.serviceRequestCooldownSeconds, new Date()).state,
  };
}

/**
 * Read-only — polled by the guest screen to observe "Requested" become
 * "Acknowledged" become (after resolution) "Cooldown" become "Available"
 * again, without ever inserting (unlike requestStaff). The server
 * re-evaluates the cooldown window fresh on every call, so a page refresh,
 * a second tab, or a poll a long time later all land on the exact same
 * answer as the server would give right now — never a value cached only in
 * the client.
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
  const { state } = evaluateState(existing, table.serviceRequestCooldownSeconds, new Date());
  return { ok: true, ...state };
}
