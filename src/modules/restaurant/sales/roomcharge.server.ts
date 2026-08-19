/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Room charge: the outlet's only route to a guest folio.
 *
 * Order of operations is deliberate and must not be reordered. The folio is
 * charged *first*; only a confirmed posting is allowed to become an outlet
 * payment. If the PMS refuses, nothing is recorded as settled and the till is
 * told to take another tender. If the PMS does not answer at all, the attempt
 * is left as `unknown` — never silently retried, never assumed paid — and it
 * surfaces at reconciliation as an exception a human must clear.
 */
import { assertCapability } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { folioIdempotencyKey, folioFailureMessage } from "@/domains/hospitality/folio/folio.rules";
import { loadPmsFolioPort } from "../core/ports/pms-folio.port";
import type { RoomChargeCommitInput, RoomChargeQuoteInput, RoomChargeSearchInput } from "./roomcharge.contracts";
import { takePosPayment } from "./pos.server";

type Sb = any;

async function loadOrder(sb: Sb, tenantId: string, orderId: string) {
  const { data } = await sb
    .from("restaurant_orders")
    .select("id, order_number, status, payment_state, total, paid_total, currency, location_id, property_id, table_id")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .single();
  if (!data) throw new Error("Order not found.");
  return data;
}

/** In-house stays this till may charge. Read-only, capability-gated. */
export async function searchRoomChargeTargets(sb: Sb, userId: string, input: RoomChargeSearchInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.room_charge");
  const { findChargeableStays } = await loadPmsFolioPort();
  return findChargeableStays(sb, userId, { query: input.query, limit: 20 });
}

/** Pre-flight: can this exact amount go to this exact folio, right now? */
export async function quoteRoomCharge(sb: Sb, userId: string, input: RoomChargeQuoteInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.room_charge");
  const order = await loadOrder(sb, input.tenantId, input.orderId);
  const outstanding = Number(order.total ?? 0) - Number(order.paid_total ?? 0);
  if (input.amount > outstanding + 0.001) {
    return { eligible: false, code: "invalid_amount", message: folioFailureMessage("invalid_amount"), stay: null };
  }
  const { validateRoomCharge } = await loadPmsFolioPort();
  return validateRoomCharge(sb, userId, {
    bookingId: input.bookingId,
    amount: input.amount,
    currency: String(order.currency ?? "TZS"),
  });
}

export async function commitRoomCharge(sb: Sb, userId: string, input: RoomChargeCommitInput) {
  await assertCapability(sb, userId, input.tenantId, "sales.room_charge");
  const order = await loadOrder(sb, input.tenantId, input.orderId);
  const currency = String(order.currency ?? "TZS");
  const outstanding = Number(order.total ?? 0) - Number(order.paid_total ?? 0);
  if (input.amount > outstanding + 0.001) throw new Error(folioFailureMessage("invalid_amount"));

  const idempotencyKey = folioIdempotencyKey({
    tenantId: input.tenantId,
    orderId: input.orderId,
    clientRequestId: input.clientRequestId,
  });

  const adapter = await loadPmsFolioPort();
  const posting = await adapter.postRoomCharge(sb, userId, {
    bookingId: input.bookingId,
    amount: input.amount,
    currency,
    description: `Outlet charge — order ${order.order_number ?? order.id}`,
    idempotencyKey,
    source: {
      sourceSystem: "restaurant_pos",
      tenantId: input.tenantId,
      propertyId: order.property_id ?? undefined,
      locationId: order.location_id ?? undefined,
      orderId: input.orderId,
      correlationId: input.clientRequestId,
    },
  });

  const eventBase = {
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_order" as const,
    entityId: input.orderId,
    source: "restaurant-pos",
  };

  if (posting.status !== "posted") {
    await emitRestaurantEvent(sb, userId, {
      ...eventBase,
      type:
        posting.status === "unknown"
          ? "restaurant.payment.room_charge_unknown"
          : "restaurant.payment.room_charge_failed",
      payload: {
        order_number: order.order_number,
        booking_id: input.bookingId,
        amount: input.amount,
        currency,
        failure_code: posting.failureCode ?? null,
        idempotency_key: idempotencyKey,
      },
      dedupeKey: `roomcharge:${posting.status}:${idempotencyKey}`,
    });
    return {
      posted: false,
      status: posting.status,
      failureCode: posting.failureCode ?? "posting_rejected",
      message: posting.failureMessage ?? folioFailureMessage(posting.failureCode),
      order: null,
      receipt: null,
    };
  }

  // Only a confirmed folio posting becomes an outlet payment. The payment row
  // shares the till's request key, so a retry cannot double-record it either.
  const result = await takePosPayment(sb, userId, {
    tenantId: input.tenantId,
    orderId: input.orderId,
    clientRequestId: input.clientRequestId,
    method: "room_charge",
    amount: input.amount,
    reference: posting.postingReference ?? undefined,
    bookingId: input.bookingId,
    state: "room_charged",
    closeWhenSettled: input.closeWhenSettled,
  });

  await sb
    .from("pms_folio_postings")
    .update({ metadata: { settled_order_id: input.orderId } })
    .eq("idempotency_key", idempotencyKey)
    .is("source_payment_id", null);

  await emitRestaurantEvent(sb, userId, {
    ...eventBase,
    type: "restaurant.payment.room_charge_posted",
    payload: {
      order_number: order.order_number,
      booking_id: input.bookingId,
      amount: input.amount,
      currency,
      folio_reference: posting.folioReference ?? null,
      posting_reference: posting.postingReference ?? null,
      duplicate: posting.duplicate,
    },
    dedupeKey: `roomcharge:posted:${idempotencyKey}`,
  });

  return {
    posted: true,
    status: "posted" as const,
    duplicate: posting.duplicate,
    postingReference: posting.postingReference ?? null,
    folioReference: posting.folioReference ?? null,
    order: result.order,
    settled: result.settled,
    receipt: result.receipt,
  };
}
