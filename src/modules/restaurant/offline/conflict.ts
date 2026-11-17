/**
 * P10 Phase 10 — conflict model.
 *
 * This module never predicts conflicts from a local, possibly-stale view of
 * server state — "authoritative server reconciliation" (P10 Phase 9) means
 * the server's own response at sync time is the one source of truth about
 * whether an operation still makes sense. classifyOutcome reads what the
 * real server function actually returned or threw and maps it to one of
 * the mission's five outcomes. It is deliberately conservative: every
 * financial/order-lifecycle ambiguity resolves to SERVER_WINS or
 * REQUIRES_OPERATOR, never CLIENT_WINS — this pass ships no scenario where
 * a locally-queued write is allowed to silently overwrite authoritative
 * server state.
 */
import type { ConflictOutcome, QueueableOperationType } from "./contracts";

export interface ClassifiedOutcome {
  /** True if the operation should be treated as successfully applied
   * (including a natural idempotent no-op, e.g. fire_to_kitchen finding
   * nothing left to fire). */
  success: boolean;
  outcome: ConflictOutcome | null;
  /** A short, operator-facing reason — never a raw stack trace. */
  reason: string | null;
  /** Whether retrying this exact operation later could succeed (a
   * transient network/server error) vs. never will (a genuine business
   * rule conflict). */
  retryable: boolean;
}

const CLOSED_ORDER_PATTERNS = [
  /This bill is closed and can no longer be modified/i,
  /A closed order cannot be fired to the kitchen/i,
];
const NOT_FOUND_PATTERNS = [/Order not found/i];
const FORBIDDEN_PATTERNS = [/^Forbidden/i];
// requireSupabaseAuth (src/integrations/supabase/auth-middleware.ts) throws
// exactly these "Unauthorized: ..." messages for every expired/invalid/
// missing-token case — the real "session expired offline" /
// "authorization revoked while offline" boundary. Same treatment as
// Forbidden: never auto-retried, always surfaced to an operator.
const UNAUTHORIZED_PATTERNS = [/^Unauthorized/i];

/**
 * Classifies the result of one sync attempt. `error` is the caught
 * exception (if the server function threw); `result` is its return value
 * (if it resolved). Exactly one of the two is populated by the caller.
 */
export function classifyOutcome(
  operationType: QueueableOperationType,
  { result, error }: { result?: unknown; error?: unknown },
): ClassifiedOutcome {
  if (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (NOT_FOUND_PATTERNS.some((p) => p.test(message))) {
      // The order this add_item/fire_to_kitchen op targets doesn't exist
      // server-side — either its own open_order op hasn't synced yet (a
      // dependency-ordering bug, since the queue is meant to replay in
      // sequence) or the order was genuinely deleted. Either way this is
      // not a business-rule conflict the operator caused; conservative
      // default: require a human look rather than guess.
      return {
        success: false,
        outcome: "REQUIRES_OPERATOR",
        reason: "The order this operation targets could not be found on the server.",
        retryable: false,
      };
    }

    if (CLOSED_ORDER_PATTERNS.some((p) => p.test(message))) {
      // "order already closed" from the mission's own conflict list — the
      // order moved on (closed, or already fired/served) on another
      // device or terminal while this one was offline. The server's
      // current state is authoritative; the queued mutation cannot be
      // silently applied, and cannot be silently discarded either.
      return {
        success: false,
        outcome: "SERVER_WINS",
        reason:
          "This order was closed or already progressed on another device before this operation reached the server.",
        retryable: false,
      };
    }

    if (
      FORBIDDEN_PATTERNS.some((p) => p.test(message)) ||
      UNAUTHORIZED_PATTERNS.some((p) => p.test(message))
    ) {
      // "authorization changed while offline" / "session expired offline" —
      // the device's cached context said this user/device could act here;
      // the server, which re-checks on every single call (never trusting
      // anything queued locally), disagrees — either the capability isn't
      // granted (Forbidden, from this app's own code) or the bearer token
      // itself is no longer valid (Unauthorized, from requireSupabaseAuth).
      // Never retried automatically: retrying either without a human
      // noticing is exactly the kind of silent-escalation-adjacent behavior
      // P10 Phase 17 tests against.
      return {
        success: false,
        outcome: "REQUIRES_OPERATOR",
        reason: message,
        retryable: false,
      };
    }

    // Anything else (network timeout, 500, validation error this pass
    // didn't anticipate) is treated as transient and retryable — the
    // sync engine's bounded backoff/dead-letter policy governs how many
    // times, not this classifier.
    return { success: false, outcome: null, reason: message, retryable: true };
  }

  // No error: the server accepted it, whether as a fresh write or as an
  // idempotent replay short-circuit (result.idempotent === true, when
  // present). Both are success from the queue's point of view — the
  // authoritative side effect exists exactly once either way.
  if (operationType === "fire_to_kitchen") {
    const fired = (result as { fired?: number } | undefined)?.fired ?? 0;
    return {
      success: true,
      outcome: fired > 0 ? "AUTO_RESOLVE" : "AUTO_RESOLVE",
      reason:
        fired > 0
          ? null
          : "Nothing left to fire — already fired by another device or this exact replay.",
      retryable: false,
    };
  }
  return { success: true, outcome: "AUTO_RESOLVE", reason: null, retryable: false };
}
