/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Guest post-dining feedback — table+order scoped through the same
 * resolveGuestTableContext boundary as every other guest function in this
 * module. Nothing about tenant/property/location/payment state/order
 * status is ever accepted from the client; both are re-derived here from
 * the order row. Feedback is only accepted against an order the server
 * itself has determined is paid — the same "paid" boundary
 * selforder-recovery.ts's classifyRecoveredOrder already uses to decide
 * whether an order is settled, duplicated (not imported) because that
 * module is loaded client-side too.
 *
 * Writes go to restaurant_guest_feedback (migration
 * 0007_guest_feedback.sql) — a small, dedicated table, and a deliberately
 * distinct concept from the Intelligence module's own AI-recommendation
 * feedback schema.
 */
import { resolveGuestTableContext } from "./selforder.server";
import { classifyFeedbackRouting, type FeedbackRouting } from "./selforder-feedback";

type Sb = any;

/** Table + order scoped exactly like loadGuestOrder in selfbill.server.ts / selfstaff.server.ts. */
async function loadGuestOrderForFeedback(
  sb: Sb,
  tenantId: string,
  tableId: string,
  orderId: string,
) {
  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, status, payment_state, total, paid_total, property_id, location_id")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .eq("table_id", tableId)
    .maybeSingle();
  if (!order) throw new Error("Order not found for this table.");
  return order;
}

/** Same boundary as classifyRecoveredOrder's "paid" branch — settled regardless of order.status, since recordGuestPayment never itself closes the order. */
function isPaidOrder(order: { payment_state: string; total: number; paid_total: number }): boolean {
  const amountDue = Math.max(0, Number(order.total) - Number(order.paid_total));
  return order.payment_state === "paid" || amountDue <= 0;
}

type FeedbackRow = { rating: number; comment: string | null };

async function loadExistingFeedback(
  sb: Sb,
  tenantId: string,
  orderId: string,
): Promise<FeedbackRow | null> {
  const { data } = await sb
    .from("restaurant_guest_feedback")
    .select("rating, comment")
    .eq("tenant_id", tenantId)
    .eq("order_id", orderId)
    .maybeSingle();
  return (data as FeedbackRow | null) ?? null;
}

export type GuestFeedbackStatus =
  | { eligible: false }
  | { eligible: true; submitted: false }
  | ({ eligible: true; submitted: true; routing: FeedbackRouting } & FeedbackRow);

/** Read-only — decides whether the guest screen should even show the "How was your experience?" prompt, and what to show if feedback already exists. Never writes. */
export async function guestFeedbackStatus(
  sb: Sb,
  input: { tableId: string; orderId: string },
): Promise<GuestFeedbackStatus> {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrderForFeedback(sb, table.tenantId, input.tableId, input.orderId);

  const existing = await loadExistingFeedback(sb, table.tenantId, order.id);
  if (existing) {
    return {
      eligible: true,
      submitted: true,
      routing: classifyFeedbackRouting(existing.rating),
      ...existing,
    };
  }
  if (!isPaidOrder(order)) return { eligible: false };
  return { eligible: true, submitted: false };
}

export type SubmitGuestFeedbackResult =
  ({ ok: true; routing: FeedbackRouting } & FeedbackRow) | { ok: false; reason: "not_eligible" };

/**
 * Idempotent by construction, mirroring requestGuestBill/requestStaff: an
 * existing feedback row for this order is returned as-is — a guest cannot
 * modify feedback already submitted, and a duplicate tap never creates a
 * second row. The database's own unique (order_id) constraint is the
 * final backstop against a genuine double-tap race.
 */
export async function submitGuestFeedback(
  sb: Sb,
  input: { tableId: string; orderId: string; rating: number; comment?: string | null },
): Promise<SubmitGuestFeedbackResult> {
  const table = await resolveGuestTableContext(sb, input.tableId);
  const order = await loadGuestOrderForFeedback(sb, table.tenantId, input.tableId, input.orderId);

  const existing = await loadExistingFeedback(sb, table.tenantId, order.id);
  if (existing) {
    return { ok: true, routing: classifyFeedbackRouting(existing.rating), ...existing };
  }
  if (!isPaidOrder(order)) {
    return { ok: false, reason: "not_eligible" };
  }

  const comment = input.comment?.trim() || null;
  const { data: inserted, error } = await sb
    .from("restaurant_guest_feedback")
    .insert({
      tenant_id: table.tenantId,
      property_id: order.property_id ?? table.propertyId,
      location_id: order.location_id ?? table.locationId,
      table_id: table.tableId,
      order_id: order.id,
      rating: input.rating,
      comment,
      source: "self_order",
    })
    .select("rating, comment")
    .single();

  if (error) {
    // A concurrent tap already won the race and inserted the row (the
    // database's own unique-per-order guard) — read back what exists
    // rather than surfacing this as a failure to the guest.
    if (String(error.code) === "23505") {
      const raced = await loadExistingFeedback(sb, table.tenantId, order.id);
      if (raced) return { ok: true, routing: classifyFeedbackRouting(raced.rating), ...raced };
    }
    throw new Error(error.message);
  }

  // Not routed through emitRestaurantEvent/recordEvent: that path calls
  // assertIntelRead(supabase, userId), which requires a real staff
  // principal, and there is none here — the same, already-made decision
  // documented on requestGuestBill in selfbill.server.ts. Guest-originated
  // self-order actions do not emit into the Intelligence Core.
  return {
    ok: true,
    routing: classifyFeedbackRouting(inserted.rating),
    ...(inserted as FeedbackRow),
  };
}
