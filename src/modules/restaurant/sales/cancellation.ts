/**
 * Whole-order cancellation — the state machine.
 *
 * Before UAT-1 the only way to kill a bill was to void every line by hand, and
 * a closed bill could not be cancelled at all. This decides, from the facts of
 * the order alone, whether a cancellation is legitimate and what it must do.
 * Pure on purpose: the rule is asserted in tests, not inferred from the UI.
 */
export type OrderStage =
  | "open"
  | "sent"
  | "served"
  | "closed"
  | "cancelled"
  | "voided";

export interface CancellationFacts {
  status: string;
  paymentState: string;
  /** Net money captured and not yet refunded. */
  outstandingPaid: number;
  /** Lines already fired to a station. */
  preparedLines: number;
  /** Stock movements this order generated. */
  consumedMovements: number;
}

export type CancellationDecision =
  | { outcome: "noop"; code: "already_cancelled"; message: string }
  | {
      outcome: "cancel";
      /** Consumption must be unwound through the ledger. */
      reverseStock: boolean;
      /** Lines were prepared: the kitchen loss is real and is recorded as such. */
      wastageLikely: boolean;
      message: string;
    }
  | { outcome: "refuse"; code: string; message: string };

export function evaluateCancellation(facts: CancellationFacts): CancellationDecision {
  const status = String(facts.status);

  if (status === "cancelled" || status === "voided") {
    return { outcome: "noop", code: "already_cancelled", message: "This bill is already cancelled." };
  }

  if (!["open", "sent", "served", "closed"].includes(status)) {
    return { outcome: "refuse", code: "invalid_state", message: `A bill in state "${status}" cannot be cancelled.` };
  }

  // Money still held against the bill must go back through the refund
  // mechanism first; cancellation never silently disposes of a payment.
  if (facts.outstandingPaid > 0.009) {
    return {
      outcome: "refuse",
      code: "refund_required",
      message: `This bill still holds ${facts.outstandingPaid.toFixed(2)} in captured payment. Refund it first, then cancel.`,
    };
  }

  if (["room_charged", "comped"].includes(String(facts.paymentState))) {
    return {
      outcome: "refuse",
      code: "settlement_required",
      message: "This bill was room-charged or comped. Reverse that settlement before cancelling.",
    };
  }

  return {
    outcome: "cancel",
    reverseStock: facts.consumedMovements > 0,
    wastageLikely: facts.preparedLines > 0,
    message:
      facts.consumedMovements > 0
        ? "Cancelling and unwinding consumed stock through the ledger."
        : "Cancelling; no stock had been consumed.",
  };
}
