/* eslint-disable @typescript-eslint/no-explicit-any -- test-only mock payloads/results are untyped at this boundary. */
/**
 * P10 Phase 18 — failure/chaos testing.
 *
 * Scenarios already covered elsewhere with real assertions are not
 * duplicated here: refresh recovery, retry-then-dead-letter, and
 * closed-order/Forbidden conflicts are in syncEngine.test.ts;
 * duplicate-clientRequestId rejection and tenant isolation are in
 * queue.test.ts; corrupted-payload batch isolation and tampered-tenant
 * replay are in security.test.ts. This file covers what those don't:
 * migration failure, a reconnect storm, partial-synchronization
 * consistency, a full cold-start after a simulated device restart, and
 * storage-unavailable behavior at the point of enqueue.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, DB_NAME, isStorageAvailable, resetDbConnectionForTests } from "./db";
import {
  enqueue,
  getQueueEntry,
  listQueueForTenant,
  pruneSynced,
  totalQueueDepth,
  transitionQueueEntry,
} from "./queue";
import { syncPendingQueue, syncStatusFor, type SyncCallers } from "./syncEngine";

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

const TENANT = "tenant-1";

function makeCallers(overrides: Partial<SyncCallers> = {}): SyncCallers {
  return {
    openOrder: vi.fn(async () => ({ id: "server-order-1" })),
    addItems: vi.fn(async () => ({ items: [] })),
    fireToKitchen: vi.fn(async () => ({ fired: 1 })),
    ...overrides,
  };
}

describe("Chaos — IndexedDB migration/open failure", () => {
  it("isStorageAvailable returns false, deterministically, when indexedDB.open itself errors (simulating a locked-down browser storage quota/permission failure)", async () => {
    const real = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null } as any;
      queueMicrotask(() => req.onerror?.(new Event("error")));
      Object.defineProperty(req, "error", { value: new Error("QuotaExceededError") });
      return req;
    };
    resetDbConnectionForTests();
    try {
      expect(await isStorageAvailable()).toBe(false);
    } finally {
      indexedDB.open = real;
      resetDbConnectionForTests();
    }
  });

  it("a failed open does not wedge future attempts — a subsequent real open still succeeds once the transient failure clears", async () => {
    const real = indexedDB.open.bind(indexedDB);
    let attempt = 0;
    indexedDB.open = (...args: any[]) => {
      attempt += 1;
      if (attempt === 1) {
        const req = { onerror: null } as any;
        Object.defineProperty(req, "error", { value: new Error("transient") });
        queueMicrotask(() => req.onerror?.(new Event("error")));
        return req;
      }
      return real(...(args as [string, number]));
    };
    resetDbConnectionForTests();
    expect(await isStorageAvailable()).toBe(false);
    resetDbConnectionForTests();
    indexedDB.open = real;
    expect(await isStorageAvailable()).toBe(true);
  });
});

describe("Chaos — reconnect storm", () => {
  it("10 rapid-fire concurrent sync calls for the same tenant result in exactly one real attempt per operation, never a duplicate server call from the storm itself", async () => {
    await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: {},
    });
    const openOrder = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { id: "server-order-1" };
    });
    const callers = makeCallers({ openOrder });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => syncPendingQueue(TENANT, callers)),
    );
    expect(openOrder).toHaveBeenCalledTimes(1);
    const succeeded = results.filter((r) => r.synced === 1);
    const lockedOut = results.filter((r) => r.alreadyInProgress);
    expect(succeeded).toHaveLength(1);
    expect(lockedOut.length).toBeGreaterThanOrEqual(9);
  });

  it("repeated reconnect cycles (offline→online→offline→online) each trigger an independent, correctly-scoped sync pass with no leaked state between cycles", async () => {
    const openOrder = vi.fn(async (p: any) => ({ id: `server-${p.marker}` }));
    const callers = makeCallers({ openOrder });

    for (const marker of ["cycle-1", "cycle-2", "cycle-3"]) {
      await enqueue({
        clientRequestId: crypto.randomUUID(),
        deviceId: "device-1",
        tenantId: TENANT,
        propertyId: null,
        outletId: null,
        operationType: "open_order",
        payload: { marker },
      });
      const summary = await syncPendingQueue(TENANT, callers);
      expect(summary.synced).toBe(1);
    }
    expect(openOrder).toHaveBeenCalledTimes(3);
    const all = await listQueueForTenant(TENANT);
    expect(all.every((o) => o.state === "SYNCED")).toBe(true);
  });
});

describe("Chaos — partial synchronization consistency", () => {
  it("a batch of 5 with mixed outcomes (2 succeed, 1 conflicts, 2 exhaust retries to dead-letter) leaves a fully consistent, individually-correct final state for every entry — no cross-contamination between entries", async () => {
    const clientRequestIds = Array.from({ length: 5 }, () => crypto.randomUUID());
    for (const clientRequestId of clientRequestIds) {
      await enqueue({
        clientRequestId,
        deviceId: "device-1",
        tenantId: TENANT,
        propertyId: null,
        outletId: null,
        operationType: "open_order",
        payload: { clientRequestId },
      });
    }
    let call = 0;
    const openOrder = vi.fn(async (p: any) => {
      call += 1;
      const index = clientRequestIds.indexOf(p.clientRequestId);
      if (index === 0 || index === 1) return { id: `server-${index}` }; // succeed
      if (index === 2) throw new Error("This bill is closed and can no longer be modified."); // conflict
      throw new Error("persistent 500"); // 3 and 4 -> eventually dead-letter
    });
    const callers = makeCallers({ openOrder });

    for (let i = 0; i < 6; i += 1) await syncPendingQueue(TENANT, callers);

    const all = await listQueueForTenant(TENANT);
    const byIndex = clientRequestIds.map((id) => all.find((o) => o.clientRequestId === id)!.state);
    expect(byIndex[0]).toBe("SYNCED");
    expect(byIndex[1]).toBe("SYNCED");
    expect(byIndex[2]).toBe("CONFLICT");
    expect(byIndex[3]).toBe("DEAD_LETTER");
    expect(byIndex[4]).toBe("DEAD_LETTER");
  });
});

describe("Chaos — device restart (full cold start)", () => {
  it("after a simulated device restart (connection closed, module-level cache cleared — the actual state left on a real page unload), every queue entry from before the restart is still there with its exact prior state", async () => {
    const synced = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: {},
    });
    await transitionQueueEntry(synced.operationId, { state: "SYNCED", serverResult: { id: "x" } });
    const pending = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: {},
    });

    // "Device restart": close the connection and drop every in-memory
    // module cache this process holds — there is nothing left to leak
    // across this boundary except what's actually on disk.
    await closeDb();

    const afterRestart = await listQueueForTenant(TENANT);
    expect(afterRestart).toHaveLength(2);
    expect(afterRestart.find((o) => o.operationId === synced.operationId)?.state).toBe("SYNCED");
    expect(afterRestart.find((o) => o.operationId === pending.operationId)?.state).toBe("PENDING");

    // And the still-pending one can resume syncing normally post-restart.
    const summary = await syncPendingQueue(TENANT, makeCallers());
    expect(summary.synced).toBe(1);
  });
});

describe("ME-09 — realistic queue size / storage-load behavior", () => {
  it("a device that queued 500 operations across a busy offline shift replays every one correctly, in order, with no loss and a consistent final state breakdown", async () => {
    const COUNT = 500;
    const clientRequestIds = Array.from({ length: COUNT }, (_, i) => `bulk-${i}`);
    const indexByClientRequestId = new Map(clientRequestIds.map((id, i) => [id, i]));
    for (const clientRequestId of clientRequestIds) {
      await enqueue({
        clientRequestId,
        deviceId: "device-1",
        tenantId: TENANT,
        propertyId: null,
        outletId: null,
        operationType: "open_order",
        payload: { clientRequestId },
      });
    }
    expect(await totalQueueDepth()).toBe(COUNT);

    // Fail every 10th deterministically to prove partial failure at scale
    // doesn't corrupt or lose sibling entries (P10/ME-09 invariant G).
    const openOrder = vi.fn(async (p: any) => {
      const index = indexByClientRequestId.get(p.clientRequestId)!;
      if (index % 10 === 0) throw new Error("persistent 500");
      return { id: `server-${p.clientRequestId}` };
    });
    const callers = makeCallers({ openOrder });

    // Enough passes to drive the failing 10% to DEAD_LETTER
    // (MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 5) without looping unboundedly.
    for (let i = 0; i < 5; i += 1) await syncPendingQueue(TENANT, callers);

    const all = await listQueueForTenant(TENANT);
    expect(all).toHaveLength(COUNT);
    // Local sequence order is preserved regardless of batch size.
    expect(all.map((o) => o.sequence)).toEqual(
      [...all].sort((a, b) => a.sequence - b.sequence).map((o) => o.sequence),
    );

    const synced = all.filter((o) => o.state === "SYNCED");
    const deadLettered = all.filter((o) => o.state === "DEAD_LETTER");
    expect(synced).toHaveLength(COUNT - COUNT / 10);
    expect(deadLettered).toHaveLength(COUNT / 10);

    const status = await syncStatusFor(TENANT);
    expect(status.synced).toBe(COUNT - COUNT / 10);
    expect(status.deadLettered).toBe(COUNT / 10);
    expect(status.pending).toBe(0);
  }, 20_000); // 500 ops x 5 sync passes over fake-indexeddb genuinely takes longer than the 5s default under full-suite parallel load; this is bulk I/O, not a hang.

  it("pruning at scale removes only aged SYNCED entries and leaves every non-terminal/recent entry intact, without pathological slowdown or partial application", async () => {
    const OLD_SYNCED = 300;
    const RECENT_SYNCED = 50;
    const STILL_PENDING = 20;
    const { put: dbPut, STORES: dbStores } = await import("./db");

    for (let i = 0; i < OLD_SYNCED; i += 1) {
      const op = await enqueue({
        clientRequestId: `old-${i}`,
        deviceId: "device-1",
        tenantId: TENANT,
        propertyId: null,
        outletId: null,
        operationType: "open_order",
        payload: {},
      });
      await transitionQueueEntry(op.operationId, { state: "SYNCED" });
      const raw = await getQueueEntry(op.operationId);
      await dbPut(dbStores.queue, { ...raw, createdAt: new Date(0).toISOString() });
    }
    for (let i = 0; i < RECENT_SYNCED; i += 1) {
      const op = await enqueue({
        clientRequestId: `recent-${i}`,
        deviceId: "device-1",
        tenantId: TENANT,
        propertyId: null,
        outletId: null,
        operationType: "open_order",
        payload: {},
      });
      await transitionQueueEntry(op.operationId, { state: "SYNCED" });
    }
    for (let i = 0; i < STILL_PENDING; i += 1) {
      await enqueue({
        clientRequestId: `pending-${i}`,
        deviceId: "device-1",
        tenantId: TENANT,
        propertyId: null,
        outletId: null,
        operationType: "open_order",
        payload: {},
      });
    }

    expect(await totalQueueDepth()).toBe(OLD_SYNCED + RECENT_SYNCED + STILL_PENDING);
    const removed = await pruneSynced(TENANT);
    expect(removed).toBe(OLD_SYNCED);

    const remaining = await listQueueForTenant(TENANT);
    expect(remaining).toHaveLength(RECENT_SYNCED + STILL_PENDING);
    expect(remaining.filter((o) => o.state === "SYNCED")).toHaveLength(RECENT_SYNCED);
    expect(remaining.filter((o) => o.state === "PENDING")).toHaveLength(STILL_PENDING);
  }, 20_000); // ~370 sequential IndexedDB round trips genuinely takes longer than the 5s default under full-suite parallel load.
});

describe("Chaos — storage unavailable at the moment of enqueue", () => {
  it("enqueue rejects cleanly (a catchable promise rejection) rather than crashing uncaught when IndexedDB is entirely unavailable", async () => {
    const real = (globalThis as any).indexedDB;
    resetDbConnectionForTests();
    delete (globalThis as any).indexedDB;
    try {
      await expect(
        enqueue({
          clientRequestId: crypto.randomUUID(),
          deviceId: "device-1",
          tenantId: TENANT,
          propertyId: null,
          outletId: null,
          operationType: "open_order",
          payload: {},
        }),
      ).rejects.toBeTruthy();
    } finally {
      (globalThis as any).indexedDB = real;
      resetDbConnectionForTests();
    }
  });
});
