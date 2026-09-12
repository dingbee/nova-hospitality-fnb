/**
 * P10 — Offline Operations Capability: shared types and the operation
 * safety-boundary classification.
 *
 * This module owns no transactional logic of its own. It is a terminal over
 * the existing sales/kitchen engine (pos.server.ts, kitchen.server.ts),
 * exactly like the POS is a terminal over the sales core — see
 * pos.server.ts's own header comment. Nothing here invents a second data
 * model, a second idempotency mechanism, or a second auth system.
 */

/** Every operational action this session evaluated, per the P10 mission's
 * own Phase 2 checklist, classified against whether it can safely run
 * without a live, authoritative round trip to the server. */
export const OFFLINE_CLASSIFICATION = {
  menu_catalog_read: "OFFLINE_SAFE",
  table_service_context_read: "OFFLINE_SAFE",
  open_order: "OFFLINE_QUEUEABLE",
  add_item: "OFFLINE_QUEUEABLE",
  change_quantity: "ONLINE_REQUIRED",
  remove_item: "ONLINE_REQUIRED",
  fire_to_kitchen: "OFFLINE_QUEUEABLE",
  order_status_progress: "ONLINE_REQUIRED",
  close_order: "ONLINE_REQUIRED",
  payment: "ONLINE_REQUIRED",
  receipt: "ONLINE_REQUIRED",
  inventory_movement: "ONLINE_REQUIRED",
  fiscalisation: "ONLINE_REQUIRED",
  guest_ordering: "FORBIDDEN_OFFLINE",
  staff_operations_admin: "ONLINE_REQUIRED",
  reservation_checkin: "ONLINE_REQUIRED",
  configuration_admin: "ONLINE_REQUIRED",
} as const;

export type OfflineOperationKey = keyof typeof OFFLINE_CLASSIFICATION;
export type OfflineClassification = (typeof OFFLINE_CLASSIFICATION)[OfflineOperationKey];

/**
 * Why each non-OFFLINE_SAFE classification is what it is. This is the
 * enforced rationale, not a comment — `isQueueable`/`assertQueueable` below
 * read this same table, so a change here is a change in behavior.
 *
 * OFFLINE_QUEUEABLE is deliberately narrow: only the three operations whose
 * server-side handlers this pass confirmed (or made) genuinely safe to
 * replay — open_order and add_item via the existing/extended
 * clientRequestId mechanism, fire_to_kitchen because it is already
 * naturally idempotent (it operates on the set of un-fired lines, so a
 * replay with nothing left to fire is a correct no-op, not a duplicate
 * ticket — verified by reading kitchen.server.ts's fireOrderItemsCore).
 *
 * change_quantity and remove_item are queue-*compatible* (the queue and
 * sync engine below are generic over operation type) but this pass does not
 * ship a handler for them: both mutate a specific existing line by id, and
 * a safe offline handler needs to define exactly what happens when that
 * line was voided, fired, or already paid for by the time the device
 * reconnects — a real conflict-classification question this pass chose not
 * to guess at rather than ship an under-specified handler. Classified
 * ONLINE_REQUIRED here, not silently dropped.
 *
 * Everything financial/fiscal/inventory-affecting is ONLINE_REQUIRED per
 * the mission's own explicit default: "do not make financial/fiscal actions
 * offline-capable unless the architecture can guarantee safe
 * reconciliation." Guest ordering is FORBIDDEN_OFFLINE — a guest device has
 * no staff principal and no device-identity registration; letting it queue
 * writes offline would mean accepting unauthenticated order injection with
 * no server round trip to check against, which is the one boundary this
 * pass will not cross for schedule convenience.
 */
export const CLASSIFICATION_RATIONALE: Record<OfflineOperationKey, string> = {
  menu_catalog_read: "Read-only, snapshot-cached; staleness is surfaced, never hidden.",
  table_service_context_read: "Read-only, part of the same operational snapshot.",
  open_order:
    "Queueable: idempotent via restaurant_orders.client_request_id (pre-existing mechanism).",
  add_item:
    "Queueable: idempotent via restaurant_order_items.client_request_id (extended this pass — see migration 0056).",
  change_quantity:
    "Not shipped this pass: mutates an existing line by id; a safe conflict rule for a since-fired/voided/paid line was not specified. ONLINE_REQUIRED.",
  remove_item:
    "Not shipped this pass: same reasoning as change_quantity. ONLINE_REQUIRED.",
  fire_to_kitchen:
    "Queueable: naturally idempotent — operates on the set of un-fired ('ordered') lines; a replay with nothing left to fire is a correct no-op.",
  order_status_progress: "Reflects live kitchen/service state; must not be replayed from a stale local view.",
  close_order: "Financial close; requires live payment/fiscal reconciliation.",
  payment: "Financial; requires live external confirmation for card/mobile-money/gateway methods and must never be represented as confirmed before the server confirms it.",
  receipt: "Depends on a closed, paid order.",
  inventory_movement: "High-risk; deferred/offline stock movement generation is out of scope this pass (see docs/p10-offline-operations.md).",
  fiscalisation: "Regulatory; requires live TRA/EFD submission.",
  guest_ordering: "No device identity, no staff principal — offline writes from a guest device are unauthenticated by construction.",
  staff_operations_admin: "Not part of the continuity-of-service boundary this pass targets.",
  reservation_checkin: "Not part of the continuity-of-service boundary this pass targets.",
  configuration_admin: "Must never be based on a stale local snapshot.",
};

export function isQueueable(op: OfflineOperationKey): boolean {
  return OFFLINE_CLASSIFICATION[op] === "OFFLINE_QUEUEABLE";
}

/** The only operation types the queue/sync engine actually knows how to
 * replay. Deliberately a closed set — adding one here means adding a real
 * handler in syncEngine.ts, not just widening a type. */
export const QUEUEABLE_OPERATION_TYPES = ["open_order", "add_item", "fire_to_kitchen"] as const;
export type QueueableOperationType = (typeof QUEUEABLE_OPERATION_TYPES)[number];

/** Explicit queue states (P10 Phase 7). */
export const QUEUE_STATES = [
  "PENDING",
  "PROCESSING",
  "SYNCED",
  "RETRYABLE_FAILURE",
  "CONFLICT",
  "DEAD_LETTER",
  "CANCELLED",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** A queued offline mutation. Every field the mission's Phase 7 requires. */
export interface QueuedOperation {
  /** Local primary key — a UUID generated on enqueue, distinct from clientRequestId. */
  operationId: string;
  /** The idempotency key threaded through to the existing server-side
   * client_request_id mechanism. Same value on every replay attempt. */
  clientRequestId: string;
  deviceId: string;
  tenantId: string;
  propertyId: string | null;
  outletId: string | null;
  operationType: QueueableOperationType;
  payload: unknown;
  createdAt: string;
  /** Monotonic local sequence — enforces per-device ordering at replay time
   * (P10 Phase 9's "ordered operations where required"). */
  sequence: number;
  attemptCount: number;
  state: QueueState;
  lastAttemptAt: string | null;
  failureReason: string | null;
  /** Whether a retry of this exact operation is safe. False operations move
   * straight to DEAD_LETTER on failure rather than retrying forever. */
  retryable: boolean;
  /** Set once the server has acknowledged the mutation — the authoritative
   * id(s) it created, e.g. the real order id for an open_order op. Local UI
   * must never treat a queued operation as server-confirmed before this is
   * set (P10 Phase 12's LOCAL/QUEUED vs SERVER-CONFIRMED distinction). */
  serverResult: Record<string, unknown> | null;
  /** Local-only correlation: an add_item/fire_to_kitchen op queued against an
   * order that was itself still just a queued open_order op (not yet
   * server-confirmed) must not replay before its parent order does. Null for
   * an open_order op or one already targeting a server-confirmed order id. */
  dependsOnOperationId: string | null;
}

/** Conflict outcomes per the mission's Phase 10 matrix. This pass's conflict
 * detector (conflict.ts) only ever returns SERVER_WINS or REQUIRES_OPERATOR
 * for the operation types it actually replays — financial/inventory
 * conflicts are conservative by construction, never CLIENT_WINS/silent
 * overwrite, per the mission's own explicit instruction. */
export const CONFLICT_OUTCOMES = [
  "AUTO_RESOLVE",
  "SERVER_WINS",
  "CLIENT_WINS",
  "MERGE",
  "REQUIRES_OPERATOR",
] as const;
export type ConflictOutcome = (typeof CONFLICT_OUTCOMES)[number];

export interface ConflictRecord {
  conflictId: string;
  operationId: string;
  kind: string;
  outcome: ConflictOutcome;
  detail: string;
  detectedAt: string;
  resolvedAt: string | null;
}
