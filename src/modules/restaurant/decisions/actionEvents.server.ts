/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P10 — Act/Verify event emission.
 *
 * `emitRestaurantEvent` (restaurant/events/emit.server.ts) restricts `type`
 * to `RESTAURANT_EVENT_TYPES`, which is exhaustively `restaurant.*`/`bar.*`.
 * The Intelligence Core's Act/Verify lifecycle names its events
 * `intelligence.action.*` — a different, module-spanning vocabulary — so
 * this calls `recordEvent` (the same underlying, tenant-scoped, idempotent
 * writer `emitRestaurantEvent` itself wraps) directly, rather than widening
 * that enum to a naming convention it doesn't belong to. No second event
 * mechanism is introduced: same table, same TenantScopeChecker registry,
 * same dedupe-key idempotency.
 */
import { recordEvent } from "@/modules/intelligence/events/events.server";

type Sb = any;

export const ACTION_EVENT_TYPES = [
  "intelligence.action.queued",
  "intelligence.action.executing",
  "intelligence.action.executed",
  "intelligence.action.failed",
  "intelligence.action.verified",
  "intelligence.action.verification_failed",
] as const;
export type ActionEventType = (typeof ACTION_EVENT_TYPES)[number];

const ACTION_EVENT_SEVERITY: Record<ActionEventType, "info" | "medium" | "high"> = {
  "intelligence.action.queued": "info",
  "intelligence.action.executing": "info",
  "intelligence.action.executed": "info",
  "intelligence.action.failed": "medium",
  "intelligence.action.verified": "info",
  "intelligence.action.verification_failed": "high",
};

/**
 * Never throws — an event that fails to record must never fail the
 * governed business action it describes (mirrors emitRestaurantEvent's
 * contract exactly).
 */
export async function emitActionEvent(
  sb: Sb,
  userId: string,
  input: {
    type: ActionEventType;
    tenantId: string;
    module: string;
    actionId: string;
    decisionId: string;
    payload?: Record<string, unknown>;
  },
): Promise<{ delivered: boolean; duplicate: boolean; reason?: string }> {
  const occurredAt = new Date().toISOString();
  try {
    const res = await recordEvent(sb, userId, {
      module: input.module as any,
      tenantId: input.tenantId,
      eventType: input.type,
      entityType: "intelligence_action",
      entityId: input.actionId,
      severity: ACTION_EVENT_SEVERITY[input.type],
      source: "intelligence-core",
      payload: { decision_id: input.decisionId, ...input.payload },
      correlationId: input.actionId,
      // Millisecond-precision timestamp keeps this a guard against a literal
      // double-call (e.g. a network retry of the same emit), not a collapse
      // of two genuinely separate transitions (e.g. a retry after failure
      // re-entering "queued" a second time is a real, distinct event).
      dedupeKey: `${input.type}:${input.actionId}:${occurredAt}`,
      occurredAt,
    });
    return { delivered: true, duplicate: Boolean(res.duplicate) };
  } catch (err) {
    console.error(
      "[intelligence-core] action event not recorded — possible implementation defect",
      input.type,
      err,
    );
    return { delivered: false, duplicate: false, reason: (err as Error).message };
  }
}
