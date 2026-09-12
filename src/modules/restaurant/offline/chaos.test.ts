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
import { enqueue, listQueueForTenant, transitionQueueEntry } from "./queue";
import { syncPendingQueue, type SyncCallers } from "./syncEngine";

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
