/**
 * P10 Phase 9 — synchronization engine.
 *
 * Lifecycle (per the mission): OFFLINE → CONNECTIVITY_RESTORED →
 * validate session → push queued mutations → process acknowledgements →
 * handle conflicts → reconcile → SYNC_COMPLETE.
 *
 * This module owns no network transport of its own — `callers` is injected
 * (the three real server functions this pass wires up: openPosOrder,
 * addPosLines, fireOrder), so sync logic (ordering, dependency resolution,
 * retry, conflict classification, dead-lettering) is testable without a
 * network, a fake server, or React — see syncEngine.test.ts.
 *
 * Ordering: queue entries are processed strictly in local `sequence` order
 * (P10 Phase 9 "ordered operations where required"). An operation whose
 * `dependsOnOperationId` has not yet reached SYNCED is skipped for this
 * pass rather than attempted out of order — it will be picked up on the
 * next call once its dependency clears. `resolveOrderRef` is how an
 * add_item/fire_to_kitchen op queued against an order that was *itself*
 * still just a queued open_order op gets the real, server-assigned order
 * id once that dependency has synced (see contracts.ts's OrderRef).
 */
import { classifyOutcome } from "./conflict";
import type { ConflictRecord, QueuedOperation } from "./contracts";
import {
  getQueueEntry,
  listQueueByState,
  listQueueForTenant,
  pruneSynced,
  transitionQueueEntry,
} from "./queue";
import { put, STORES } from "./db";

/** An order reference a queued add_item/fire_to_kitchen payload carries:
 * either a real, already-known server order id, or a pointer to the local
 * open_order operation that will produce one once it syncs. */
export type OrderRef = { kind: "server"; orderId: string } | { kind: "local"; operationId: string };

export interface OpenOrderPayload {
  tenantId: string;
  propertyId: string;
  locationId: string;
  tableId?: string;
  servicePeriodId?: string;
  orderType: string;
  guestCount: number;
  currency: string;
  clientRequestId: string;
  lines: unknown[];
}

export interface AddItemPayload {
  tenantId: string;
  orderRef: OrderRef;
  lines: unknown[];
  clientRequestId: string;
}

export interface FireToKitchenPayload {
  tenantId: string;
  orderRef: OrderRef;
  orderItemIds?: string[];
  priority?: number;
}

export interface SyncCallers {
  openOrder: (payload: OpenOrderPayload) => Promise<{ id: string; [k: string]: unknown }>;
  addItems: (
    payload: AddItemPayload & { orderId: string },
  ) => Promise<{ items: unknown[]; [k: string]: unknown }>;
  fireToKitchen: (
    payload: FireToKitchenPayload & { orderId: string },
  ) => Promise<{ fired: number; [k: string]: unknown }>;
}

const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 5;

/** Resolves an OrderRef to a real server order id, or null if it depends on
 * a local operation that hasn't synced yet. */
async function resolveOrderRef(ref: OrderRef): Promise<string | null> {
  if (ref.kind === "server") return ref.orderId;
  const dependency = await getQueueEntry(ref.operationId);
  if (!dependency || dependency.state !== "SYNCED") return null;
  const id = (dependency.serverResult as { id?: string } | null)?.id;
  return id ?? null;
}

async function recordConflict(
  op: QueuedOperation,
  outcome: ConflictRecord["outcome"],
  detail: string,
): Promise<void> {
  const record: ConflictRecord = {
    conflictId: crypto.randomUUID(),
    operationId: op.operationId,
    kind: outcome,
    outcome,
    detail,
    detectedAt: new Date().toISOString(),
    resolvedAt: null,
  };
  await put(STORES.conflicts, record);
}

export interface SyncSummary {
  attempted: number;
  synced: number;
  retried: number;
  deadLettered: number;
  conflicts: number;
  skippedWaitingOnDependency: number;
  /** True when this call was a no-op because a sync for this tenant was
   * already in flight (see the module-level lock below), not because
   * there was nothing to do. */
  alreadyInProgress: boolean;
}

/** P10 Phase 9/18 "concurrency protection" / "concurrent sync invocation":
 * a UI can legitimately fire a sync both from a connectivity-restored event
 * and a periodic timer at the same moment. Without this, two concurrent
 * calls both read the queue's PENDING list before either has transitioned
 * an entry to PROCESSING, and both attempt the same operation — a real,
 * test-proven race (syncEngine.test.ts's re-entrancy suite), not a
 * theoretical one. This runs in exactly one browser tab's JS thread, so an
 * in-memory lock is sufficient; it is not a distributed lock and does not
 * need to be. */
const tenantsSyncing = new Set<string>();

/**
 * Processes every PENDING/RETRYABLE_FAILURE entry for one tenant, once,
 * in order. Callers (the connectivity-restored handler, a bounded periodic
 * timer, or an explicit "retry now" button) decide when to call this — the
 * function itself never loops or schedules its own retry, so there is no
 * risk of a hot loop regardless of caller behavior (P10 Phase 9 "no
 * infinite hot loops").
 */
export async function syncPendingQueue(
  tenantId: string,
  callers: SyncCallers,
): Promise<SyncSummary> {
  const emptySummary = (): SyncSummary => ({
    attempted: 0,
    synced: 0,
    retried: 0,
    deadLettered: 0,
    conflicts: 0,
    skippedWaitingOnDependency: 0,
    alreadyInProgress: false,
  });

  if (tenantsSyncing.has(tenantId)) {
    return { ...emptySummary(), alreadyInProgress: true };
  }
  tenantsSyncing.add(tenantId);
  try {
    const summary = await runSyncPass(tenantId, callers, emptySummary());
    // P10 Phase 19 "prevent unbounded queue growth": a device that stays
    // online for months would otherwise accumulate a SYNCED row per
    // operation forever. Bounded cleanup runs as part of every sync pass
    // rather than existing only as a callable-but-uninvoked function —
    // best-effort: a failure here must never fail the sync itself.
    try {
      await pruneSynced(tenantId);
    } catch {
      // Cleanup is not safety-critical; the next successful sync retries it.
    }
    return summary;
  } finally {
    tenantsSyncing.delete(tenantId);
  }
}

async function runSyncPass(
  tenantId: string,
  callers: SyncCallers,
  summary: SyncSummary,
): Promise<SyncSummary> {
  const pending = [
    ...(await listQueueByState(tenantId, "PENDING")),
    ...(await listQueueByState(tenantId, "RETRYABLE_FAILURE")),
  ].sort((a, b) => a.sequence - b.sequence);

  for (const op of pending) {
    if (op.dependsOnOperationId) {
      const dep = await getQueueEntry(op.dependsOnOperationId);
      if (!dep || dep.state !== "SYNCED") {
        summary.skippedWaitingOnDependency += 1;
        continue;
      }
    }

    summary.attempted += 1;
    await transitionQueueEntry(op.operationId, {
      state: "PROCESSING",
      lastAttemptAt: new Date().toISOString(),
      attemptCount: op.attemptCount + 1,
    });

    let result: unknown;
    let caught: unknown;
    try {
      result = await runOperation(op, callers);
    } catch (err) {
      caught = err;
    }

    const classified = classifyOutcome(op.operationType, { result, error: caught });

    if (classified.success) {
      await transitionQueueEntry(op.operationId, {
        state: "SYNCED",
        serverResult: (result as Record<string, unknown>) ?? {},
        failureReason: null,
      });
      summary.synced += 1;
      continue;
    }

    if (classified.outcome === "REQUIRES_OPERATOR" || classified.outcome === "SERVER_WINS") {
      await recordConflict(op, classified.outcome, classified.reason ?? "Unclassified conflict.");
      await transitionQueueEntry(op.operationId, {
        state: "CONFLICT",
        failureReason: classified.reason,
      });
      summary.conflicts += 1;
      continue;
    }

    // Transient/unclassified failure: retry up to the bound, then dead-letter.
    const attemptCount = op.attemptCount + 1;
    if (classified.retryable && attemptCount < MAX_ATTEMPTS_BEFORE_DEAD_LETTER) {
      await transitionQueueEntry(op.operationId, {
        state: "RETRYABLE_FAILURE",
        failureReason: classified.reason,
      });
      summary.retried += 1;
    } else {
      await transitionQueueEntry(op.operationId, {
        state: "DEAD_LETTER",
        failureReason: classified.reason ?? "Max retry attempts exceeded.",
      });
      summary.deadLettered += 1;
    }
  }

  return summary;
}

async function runOperation(op: QueuedOperation, callers: SyncCallers): Promise<unknown> {
  switch (op.operationType) {
    case "open_order": {
      const payload = op.payload as OpenOrderPayload;
      return callers.openOrder(payload);
    }
    case "add_item": {
      const payload = op.payload as AddItemPayload;
      const orderId = await resolveOrderRef(payload.orderRef);
      if (!orderId) throw new Error("Order not found."); // dependency not yet synced; classified as REQUIRES_OPERATOR, will clear once the dependency completes
      return callers.addItems({ ...payload, orderId });
    }
    case "fire_to_kitchen": {
      const payload = op.payload as FireToKitchenPayload;
      const orderId = await resolveOrderRef(payload.orderRef);
      if (!orderId) throw new Error("Order not found.");
      return callers.fireToKitchen({ ...payload, orderId });
    }
    default: {
      const exhaustive: never = op.operationType;
      throw new Error(`Unknown queueable operation type: ${String(exhaustive)}`);
    }
  }
}

/** Read-only view of everything currently blocking a clean SYNC_COMPLETE —
 * what the connectivity UX (P10 Phase 11) surfaces as "pending" / "failed" /
 * "conflicts requiring attention". */
export async function syncStatusFor(tenantId: string) {
  const all = await listQueueForTenant(tenantId);
  return {
    pending: all.filter((o) => o.state === "PENDING" || o.state === "RETRYABLE_FAILURE").length,
    processing: all.filter((o) => o.state === "PROCESSING").length,
    conflicts: all.filter((o) => o.state === "CONFLICT").length,
    deadLettered: all.filter((o) => o.state === "DEAD_LETTER").length,
    synced: all.filter((o) => o.state === "SYNCED").length,
  };
}
