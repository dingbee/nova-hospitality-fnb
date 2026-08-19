/**
 * Pure folio rules.
 *
 * The adapter talks to the PMS; this module decides *whether a charge is
 * allowed to be attempted at all*, and how an unclear answer must be described
 * to the person standing at the till. It holds no I/O so it can be tested
 * exhaustively — a wrong answer here is a wrong number on a guest's bill.
 */

export const FOLIO_FAILURE_CODES = [
  "guest_not_found",
  "stay_not_active",
  "room_not_eligible",
  "folio_unavailable",
  "pms_unavailable",
  "posting_rejected",
  "duplicate_posting",
  "currency_mismatch",
  "invalid_amount",
  "unauthorised",
  "unknown",
] as const;
export type FolioFailureCode = (typeof FOLIO_FAILURE_CODES)[number];

/** Posting states the till may see. `unknown` is never treated as settled. */
export const FOLIO_POSTING_STATUSES = ["pending", "posted", "failed", "unknown", "reversed"] as const;
export type FolioPostingStatus = (typeof FOLIO_POSTING_STATUSES)[number];

const MESSAGES: Record<FolioFailureCode, string> = {
  guest_not_found: "No in-house guest is linked to that room. Check the room number with reception.",
  stay_not_active: "That stay is not checked in, so its folio is closed. Take another form of payment.",
  room_not_eligible: "This room is not eligible for outlet charges. Reception must authorise it first.",
  folio_unavailable: "The guest folio could not be opened. Ask reception to check the reservation.",
  pms_unavailable: "The property system did not answer. Do not retry blindly — verify the folio first.",
  posting_rejected: "The property system rejected the charge. Take another form of payment.",
  duplicate_posting: "This charge has already been posted to the folio.",
  currency_mismatch: "The folio is held in a different currency to this bill.",
  invalid_amount: "A folio charge must be greater than zero and no more than the balance due.",
  unauthorised: "You are not authorised to charge a guest room.",
  unknown: "Posting status unknown — verify folio before retrying.",
};

export function folioFailureMessage(code: FolioFailureCode | string | null | undefined): string {
  return MESSAGES[(code ?? "unknown") as FolioFailureCode] ?? MESSAGES.unknown;
}

/** The minimum a till needs to know about a stay — and nothing more. */
export interface FolioStay {
  bookingId: string;
  guestName: string;
  unitLabel: string | null;
  roomName: string | null;
  arrival: string;
  departure: string;
  currency: string;
  status: string;
}

export interface EligibilityResult {
  eligible: boolean;
  code?: FolioFailureCode;
  message?: string;
}

const deny = (code: FolioFailureCode): EligibilityResult => ({
  eligible: false,
  code,
  message: folioFailureMessage(code),
});

/**
 * Decides eligibility before any money moves. The stay must be checked in, the
 * folio currency must match the bill, and the amount must be real.
 */
export function evaluateRoomChargeEligibility(
  stay: FolioStay | null | undefined,
  charge: { amount: number; currency: string; balanceDue?: number },
): EligibilityResult {
  if (!stay) return deny("guest_not_found");
  if (stay.status !== "checked_in") return deny("stay_not_active");
  if (!stay.currency) return deny("folio_unavailable");
  if (stay.currency.toUpperCase() !== String(charge.currency ?? "").toUpperCase()) {
    return deny("currency_mismatch");
  }
  const amount = Number(charge.amount);
  if (!Number.isFinite(amount) || amount <= 0) return deny("invalid_amount");
  if (charge.balanceDue != null && amount > Number(charge.balanceDue) + 0.001) {
    return deny("invalid_amount");
  }
  return { eligible: true };
}

/**
 * Stable identity of one intended posting. The same till interaction always
 * produces the same key, so a double-tap or a retried network request lands on
 * the row that already exists rather than charging the guest twice.
 */
export function folioIdempotencyKey(input: {
  tenantId: string;
  orderId: string;
  clientRequestId: string;
}): string {
  return `rest:${input.tenantId}:${input.orderId}:${input.clientRequestId}`;
}

/** Only what the confirmation screen may display. */
export function stayConfirmationView(stay: FolioStay) {
  return {
    guest: stay.guestName,
    room: stay.unitLabel ?? stay.roomName ?? "—",
    arrival: stay.arrival,
    departure: stay.departure,
    currency: stay.currency,
  };
}

/** A folio charge is a receivable, never a tender taken over the counter. */
export const ROOM_CHARGE_IS_TENDER = false;
