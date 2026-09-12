/**
 * P10 Phase 7 — durable offline transaction queue.
 *
 * Every mutation queued here carries the full field set the mission
 * requires (see contracts.ts's QueuedOperation) and lives in IndexedDB —
 * durable across refresh and browser restart by the platform's own
 * guarantee, not an in-memory array. Enqueue never silently discards or
 * duplicates: a duplicate clientRequestId is rejected by the store's own
 * unique index (by_tenant_clientRequestId in db.ts) before anything is
 * written twice.
 */
import { del, get, getAll, getAllByIndex, put, STORES } from "./db";
import { nextSequence } from "./sequence";
import type { QueueableOperationType, QueuedOperation, QueueState } from "./contracts";

export interface EnqueueInput {
  clientRequestId: string;
  deviceId: string;
  tenantId: string;
  propertyId: string | null;
  outletId: string | null;
  operationType: QueueableOperationType;
  payload: unknown;
  retryable?: boolean;
  dependsOnOperationId?: string | null;
}

export class DuplicateClientRequestIdError extends Error {
  constructor(clientRequestId: string) {
    super(`An operation with clientRequestId "${clientRequestId}" is already queued.`);
    this.name = "DuplicateClientRequestIdError";
  }
}

/** Enqueues one offline mutation. Rejects (never silently coalesces) a
 * clientRequestId already present for this tenant — the caller generated a
 * fresh key per user action (see PosWorkspace's `useRef<string>(newRequestId())`
 * pattern this reuses), so a collision means a real bug upstream, not a
 * legitimate retry (a legitimate retry re-enqueues the SAME operationId via
 * `markAttempt`, it never calls `enqueue` twice). */
export async function enqueue(input: EnqueueInput): Promise<QueuedOperation> {
  const existing = await getAllByIndex<QueuedOperation>(
    STORES.queue,
    "by_tenant_clientRequestId",
    [input.tenantId, input.clientRequestId],
  );
  if (existing.length > 0) throw new DuplicateClientRequestIdError(input.clientRequestId);

  const op: QueuedOperation = {
    operationId: crypto.randomUUID(),
    clientRequestId: input.clientRequestId,
    deviceId: input.deviceId,
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    outletId: input.outletId,
    operationType: input.operationType,
    payload: input.payload,
    createdAt: new Date().toISOString(),
    sequence: await nextSequence(),
    attemptCount: 0,
    state: "PENDING",
    lastAttemptAt: null,
    failureReason: null,
    retryable: input.retryable ?? true,
    serverResult: null,
    dependsOnOperationId: input.dependsOnOperationId ?? null,
  };
  await put(STORES.queue, op);
  return op;
}

/** All queue entries for a tenant, ordered by local sequence — the order
 * they were created on this device, which is the order they must be
 * replayed in for dependent operations (add_item depends on its order
 * existing) to make sense. Tenant-scoped: never returns another tenant's
 * rows even if the caller's own bug asked for "everything". */
export async function listQueueForTenant(tenantId: string): Promise<QueuedOperation[]> {
  const rows = await getAllByIndex<QueuedOperation>(STORES.queue, "by_tenant", tenantId);
  return rows.sort((a, b) => a.sequence - b.sequence);
}

export async function listQueueByState(
  tenantId: string,
  state: QueueState,
): Promise<QueuedOperation[]> {
  const rows = await getAllByIndex<QueuedOperation>(STORES.queue, "by_tenant_state", [
    tenantId,
    state,
  ]);
  return rows.sort((a, b) => a.sequence - b.sequence);
}

export async function getQueueEntry(operationId: string): Promise<QueuedOperation | undefined> {
  return get<QueuedOperation>(STORES.queue, operationId);
}

/** Records one sync attempt's outcome. Never deletes a failed operation —
 * "never silently discard an offline transaction" (P10 Phase 7). Deletion
 * only ever happens via `pruneSynced`, and only for rows already in the
 * terminal SYNCED state, as an explicit, separate, bounded cleanup step
 * (P10 Phase 19 "prevent unbounded queue growth"). */
export async function transitionQueueEntry(
  operationId: string,
  patch: Partial<
    Pick<
      QueuedOperation,
      "state" | "attemptCount" | "lastAttemptAt" | "failureReason" | "serverResult"
    >
  >,
): Promise<QueuedOperation> {
  const current = await getQueueEntry(operationId);
  if (!current) throw new Error(`Queue entry ${operationId} not found.`);
  const updated: QueuedOperation = { ...current, ...patch };
  await put(STORES.queue, updated);
  return updated;
}

/** Bounded cleanup: removes SYNCED entries older than `olderThanMs`
 * (default 7 days) so the queue does not grow forever on a device that
 * stays online for months. Never removes anything not in a terminal state
 * (SYNCED or CANCELLED) — PENDING/RETRYABLE_FAILURE/CONFLICT/DEAD_LETTER
 * rows are operator-visible until explicitly resolved. */
export async function pruneSynced(
  tenantId: string,
  olderThanMs = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const synced = await listQueueByState(tenantId, "SYNCED");
  let removed = 0;
  for (const op of synced) {
    if (new Date(op.createdAt).getTime() < cutoff) {
      await del(STORES.queue, op.operationId);
      removed += 1;
    }
  }
  return removed;
}

export async function cancelQueueEntry(operationId: string): Promise<QueuedOperation> {
  return transitionQueueEntry(operationId, { state: "CANCELLED" });
}

/** Total queue depth across every tenant this device has ever queued for —
 * used only for a storage/performance sanity check (P10 Phase 19), never
 * for a tenant-scoped read. */
export async function totalQueueDepth(): Promise<number> {
  const rows = await getAll<QueuedOperation>(STORES.queue);
  return rows.length;
}
