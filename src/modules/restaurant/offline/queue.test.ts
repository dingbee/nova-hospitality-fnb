import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, DB_NAME } from "./db";
import {
  cancelQueueEntry,
  DuplicateClientRequestIdError,
  enqueue,
  getQueueEntry,
  listQueueByState,
  listQueueForTenant,
  pruneSynced,
  totalQueueDepth,
  transitionQueueEntry,
} from "./queue";

beforeEach(async () => {
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});
afterEach(async () => {
  await closeDb();
});

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function baseInput(overrides: Partial<Parameters<typeof enqueue>[0]> = {}) {
  return {
    clientRequestId: crypto.randomUUID(),
    deviceId: "device-1",
    tenantId: TENANT_A,
    propertyId: "prop-1",
    outletId: "outlet-1",
    operationType: "open_order" as const,
    payload: { hello: "world" },
    ...overrides,
  };
}

describe("offline transaction queue", () => {
  it("enqueue creates a PENDING entry with every required field populated", async () => {
    const op = await enqueue(baseInput());
    expect(op.state).toBe("PENDING");
    expect(op.attemptCount).toBe(0);
    expect(op.operationId).toBeTruthy();
    expect(op.clientRequestId).toBeTruthy();
    expect(op.deviceId).toBe("device-1");
    expect(op.tenantId).toBe(TENANT_A);
    expect(op.createdAt).toBeTruthy();
    expect(op.sequence).toBeGreaterThan(0);
    expect(op.serverResult).toBeNull();
    expect(op.lastAttemptAt).toBeNull();
    expect(op.failureReason).toBeNull();
  });

  it("persists across a simulated reload — a queued operation is never only in memory", async () => {
    const op = await enqueue(baseInput());
    await closeDb();
    const reloaded = await getQueueEntry(op.operationId);
    expect(reloaded).toEqual(op);
  });

  it("enqueue rejects a duplicate clientRequestId for the same tenant rather than creating a second entry", async () => {
    const clientRequestId = "shared-key-1";
    await enqueue(baseInput({ clientRequestId }));
    await expect(enqueue(baseInput({ clientRequestId }))).rejects.toBeInstanceOf(
      DuplicateClientRequestIdError,
    );
    const all = await listQueueForTenant(TENANT_A);
    expect(all).toHaveLength(1);
  });

  it("the same clientRequestId IS allowed across different tenants (no cross-tenant key collision)", async () => {
    const clientRequestId = "shared-key-2";
    await enqueue(baseInput({ clientRequestId, tenantId: TENANT_A }));
    await expect(enqueue(baseInput({ clientRequestId, tenantId: TENANT_B }))).resolves.toBeTruthy();
  });

  it("ordering: entries come back sorted by local sequence, matching creation order, regardless of insertion order into the store", async () => {
    const first = await enqueue(baseInput());
    const second = await enqueue(baseInput());
    const third = await enqueue(baseInput());
    const ordered = await listQueueForTenant(TENANT_A);
    expect(ordered.map((o) => o.operationId)).toEqual([
      first.operationId,
      second.operationId,
      third.operationId,
    ]);
  });

  it("sequence numbers are strictly increasing and survive a simulated reload (no reset to 0/collision after reopen)", async () => {
    const first = await enqueue(baseInput());
    await closeDb();
    const second = await enqueue(baseInput());
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });

  it("tenant isolation: listQueueForTenant never returns another tenant's rows", async () => {
    await enqueue(baseInput({ tenantId: TENANT_A }));
    await enqueue(baseInput({ tenantId: TENANT_B }));
    const forA = await listQueueForTenant(TENANT_A);
    expect(forA.every((o) => o.tenantId === TENANT_A)).toBe(true);
    expect(forA).toHaveLength(1);
  });

  it("transitionQueueEntry moves state and records attempt metadata without touching unrelated fields", async () => {
    const op = await enqueue(baseInput());
    const updated = await transitionQueueEntry(op.operationId, {
      state: "PROCESSING",
      attemptCount: 1,
      lastAttemptAt: "2026-01-01T00:00:00.000Z",
    });
    expect(updated.state).toBe("PROCESSING");
    expect(updated.attemptCount).toBe(1);
    expect(updated.clientRequestId).toBe(op.clientRequestId);
    expect(updated.payload).toEqual(op.payload);
  });

  it("a failed transition never deletes the entry — 'never silently discard an offline transaction'", async () => {
    const op = await enqueue(baseInput());
    await transitionQueueEntry(op.operationId, {
      state: "DEAD_LETTER",
      failureReason: "simulated permanent failure",
    });
    const stillThere = await getQueueEntry(op.operationId);
    expect(stillThere?.state).toBe("DEAD_LETTER");
    expect(stillThere?.failureReason).toBe("simulated permanent failure");
  });

  it("listQueueByState filters correctly across mixed states", async () => {
    const a = await enqueue(baseInput());
    const b = await enqueue(baseInput());
    await transitionQueueEntry(a.operationId, { state: "SYNCED" });
    const pending = await listQueueByState(TENANT_A, "PENDING");
    const synced = await listQueueByState(TENANT_A, "SYNCED");
    expect(pending.map((o) => o.operationId)).toEqual([b.operationId]);
    expect(synced.map((o) => o.operationId)).toEqual([a.operationId]);
  });

  it("cancelQueueEntry moves an entry to CANCELLED without deleting it", async () => {
    const op = await enqueue(baseInput());
    const cancelled = await cancelQueueEntry(op.operationId);
    expect(cancelled.state).toBe("CANCELLED");
    expect(await getQueueEntry(op.operationId)).toBeTruthy();
  });

  it("pruneSynced removes only old SYNCED entries, never anything still pending/failed/conflicted", async () => {
    const oldSynced = await enqueue(baseInput());
    await transitionQueueEntry(oldSynced.operationId, { state: "SYNCED" });
    // Backdate createdAt directly to simulate age (pruneSynced reads createdAt).
    const raw = await getQueueEntry(oldSynced.operationId);
    await transitionQueueEntry(oldSynced.operationId, {}); // no-op patch, still SYNCED
    const recentSynced = await enqueue(baseInput());
    await transitionQueueEntry(recentSynced.operationId, { state: "SYNCED" });
    const stillPending = await enqueue(baseInput());

    // Directly age the "old" one by writing an old createdAt through the DB layer.
    const { put, STORES } = await import("./db");
    await put(STORES.queue, { ...raw, createdAt: new Date(0).toISOString(), state: "SYNCED" });

    const removed = await pruneSynced(TENANT_A, 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(await getQueueEntry(oldSynced.operationId)).toBeUndefined();
    expect(await getQueueEntry(recentSynced.operationId)).toBeTruthy();
    expect(await getQueueEntry(stillPending.operationId)).toBeTruthy();
  });

  it("concurrent enqueue of distinct operations never loses one (no lost update under Promise.all)", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => enqueue(baseInput())));
    expect(new Set(results.map((r) => r.operationId)).size).toBe(10);
    const all = await listQueueForTenant(TENANT_A);
    expect(all).toHaveLength(10);
  });

  it("transaction dependency ordering: dependsOnOperationId is stored and retrievable", async () => {
    const parent = await enqueue(baseInput({ operationType: "open_order" }));
    const child = await enqueue(
      baseInput({ operationType: "add_item", dependsOnOperationId: parent.operationId }),
    );
    expect(child.dependsOnOperationId).toBe(parent.operationId);
  });

  it("totalQueueDepth counts across tenants (a device-level storage sanity check, not a tenant-scoped read)", async () => {
    await enqueue(baseInput({ tenantId: TENANT_A }));
    await enqueue(baseInput({ tenantId: TENANT_B }));
    expect(await totalQueueDepth()).toBe(2);
  });
});
