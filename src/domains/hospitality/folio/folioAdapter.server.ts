/* eslint-disable @typescript-eslint/no-explicit-any -- PMS rows are untyped at this boundary. */
/**
 * The single seam between an outlet and the guest folio.
 *
 * Nothing outside this file may write to a reservation's money. Every attempt —
 * successful, refused or unanswered — leaves a row in `pms_folio_postings`, so
 * a charge can always be proven or disproven at night audit.
 */
import {
  evaluateRoomChargeEligibility,
  folioFailureMessage,
  stayConfirmationView,
  type FolioFailureCode,
  type FolioPostingStatus,
  type FolioStay,
} from "./folio.rules";
import type { FolioPostInput, FolioPostingStatusInput, FolioStayLookupInput, FolioValidateInput } from "./folio.contracts";

type Sb = any;

export interface FolioPostingResult {
  status: FolioPostingStatus;
  duplicate: boolean;
  postingId?: string | null;
  postingReference?: string | null;
  folioReference?: string | null;
  amount?: number;
  currency?: string;
  failureCode?: FolioFailureCode;
  failureMessage?: string;
}

/**
 * Reading a guest's stay is POS work, not merely "being signed in". Resolved
 * through the canonical RBAC model; a caller with no permission is refused
 * here as well as by RLS.
 */
async function assertFolioRead(sb: Sb, userId: string) {
  const { data, error } = await sb.rpc("nova_has_permission", {
    _user_id: userId,
    _permission: "POS:READ",
    _tenant_id: null,
    _property_id: null,
    _outlet_id: null,
  });
  if (error || data !== true) throw new Error(folioFailureMessage("unauthorised"));
}

/** Moving money onto a guest folio requires the write permission. */
async function assertFolioWrite(sb: Sb, userId: string) {
  const { data, error } = await sb.rpc("nova_has_permission", {
    _user_id: userId,
    _permission: "POS:WRITE",
    _tenant_id: null,
    _property_id: null,
    _outlet_id: null,
  });
  if (error || data !== true) throw new Error(folioFailureMessage("unauthorised"));
}

function toStay(b: any, unitLabel: string | null, roomName: string | null): FolioStay {
  return {
    bookingId: b.id,
    guestName: b.guest_name ?? "Guest",
    unitLabel,
    roomName,
    arrival: b.check_in,
    departure: b.check_out,
    currency: String(b.currency ?? "TZS").toUpperCase(),
    status: b.status,
  };
}

/** In-house stays a till may charge, resolved by room number, reference or name. */
export async function findChargeableStays(sb: Sb, userId: string, input: FolioStayLookupInput) {
  await assertFolioRead(sb, userId);
  let q = sb
    .from("bookings")
    .select("id, reference, guest_name, check_in, check_out, currency, status, room_id, balance_due")
    .eq("status", "checked_in")
    .order("check_in", { ascending: true })
    .limit(input.bookingId ? 1 : input.limit);
  if (input.bookingId) q = q.eq("id", input.bookingId);
  const { data: bookings } = await q;
  const rows = (bookings ?? []) as any[];
  if (rows.length === 0) return { stays: [] as Array<FolioStay & { balanceDue: number }> };

  const bookingIds = rows.map((r) => r.id);
  const roomIds = [...new Set(rows.map((r) => r.room_id).filter(Boolean))];
  const [{ data: states }, { data: rooms }] = await Promise.all([
    sb.from("room_states").select("booking_id, unit_label, updated_at").in("booking_id", bookingIds),
    roomIds.length
      ? sb.from("rooms").select("id, name").in("id", roomIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const unitByBooking = new Map<string, string>();
  for (const s of (states ?? []) as any[]) {
    if (s.unit_label) unitByBooking.set(s.booking_id, s.unit_label);
  }
  const roomById = new Map(((rooms ?? []) as any[]).map((r) => [r.id, r.name]));

  const term = (input.query ?? "").trim().toLowerCase();
  const stays = rows
    .map((b) => ({
      ...toStay(b, unitByBooking.get(b.id) ?? null, roomById.get(b.room_id) ?? null),
      balanceDue: Number(b.balance_due ?? 0),
      reference: b.reference as string | null,
    }))
    .filter((s) =>
      !term
        ? true
        : [s.unitLabel, s.roomName, s.guestName, s.reference]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(term)),
    );
  return { stays };
}

/** Eligibility only — this never moves money and is safe to call on keystroke. */
export async function validateRoomCharge(sb: Sb, userId: string, input: FolioValidateInput) {
  await assertFolioRead(sb, userId);
  const { stays } = await findChargeableStays(sb, userId, { bookingId: input.bookingId, limit: 1 });
  const stay = stays[0] ?? null;
  const verdict = evaluateRoomChargeEligibility(stay, { amount: input.amount, currency: input.currency });
  return { ...verdict, stay: stay ? stayConfirmationView(stay) : null };
}

/**
 * Posts to the folio. Safe to retry with the same `idempotencyKey`: the PMS
 * function returns the original posting rather than charging twice.
 */
export async function postRoomCharge(sb: Sb, userId: string, input: FolioPostInput): Promise<FolioPostingResult> {
  await assertFolioWrite(sb, userId);
  const src = input.source ?? { sourceSystem: "restaurant_pos" };
  const { data, error } = await sb.rpc("pms_post_folio_charge", {
    _idempotency_key: input.idempotencyKey,
    _booking_id: input.bookingId,
    _amount: input.amount,
    _currency: input.currency.toUpperCase(),
    _description: input.description,
    _source: {
      source_system: src.sourceSystem ?? "restaurant_pos",
      tenant_id: src.tenantId ?? null,
      property_id: src.propertyId ?? null,
      location_id: src.locationId ?? null,
      order_id: src.orderId ?? null,
      payment_id: src.paymentId ?? null,
      correlation_id: src.correlationId ?? null,
    },
  });

  if (error) {
    // An unanswered PMS is *not* a failed charge: the till must not assume.
    return {
      status: "unknown",
      duplicate: false,
      failureCode: "pms_unavailable",
      failureMessage: folioFailureMessage("pms_unavailable"),
    };
  }
  const row = (data ?? {}) as any;
  if (row.status === "posted") {
    return {
      status: "posted",
      duplicate: Boolean(row.duplicate),
      postingId: row.posting_id ?? null,
      postingReference: row.posting_reference ?? null,
      folioReference: row.folio_reference ?? null,
      amount: Number(row.amount ?? input.amount),
      currency: String(row.currency ?? input.currency),
    };
  }
  const code = (row.failure_code ?? "posting_rejected") as FolioFailureCode;
  return {
    status: "failed",
    duplicate: false,
    failureCode: code,
    failureMessage: row.failure_message ?? folioFailureMessage(code),
  };
}

/** Truth after an interrupted posting: what does the folio actually hold? */
export async function getFolioPostingStatus(sb: Sb, userId: string, input: FolioPostingStatusInput) {
  await assertFolioRead(sb, userId);
  let q = sb
    .from("pms_folio_postings")
    .select(
      "id, booking_id, amount, currency, status, folio_reference, posting_reference, failure_code, failure_message, idempotency_key, source_order_id, posted_at, requested_at",
    )
    .order("requested_at", { ascending: false })
    .limit(20);
  if (input.idempotencyKey) q = q.eq("idempotency_key", input.idempotencyKey);
  if (input.postingId) q = q.eq("id", input.postingId);
  if (input.orderId) q = q.eq("source_order_id", input.orderId);
  const { data } = await q;
  return { postings: (data ?? []) as any[] };
}
