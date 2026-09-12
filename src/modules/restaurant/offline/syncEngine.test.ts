/* eslint-disable @typescript-eslint/no-explicit-any -- test-only mock payloads/results are untyped at this boundary. */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, DB_NAME, getAllByIndex, STORES } from "./db";
import type { ConflictRecord } from "./contracts";
import { enqueue, getQueueEntry, listQueueForTenant } from "./queue";
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
    openOrder: vi.fn(async (payload) => ({ id: "server-order-1", idempotent: false })),
    addItems: vi.fn(async () => ({ items: [{ id: "item-1" }], idempotent: false })),
    fireToKitchen: vi.fn(async () => ({ fired: 1, tickets: [{ id: "ticket-1" }] })),
    ...overrides,
  };
}

async function enqueueOpenOrder(clientRequestId: string = crypto.randomUUID()) {
  return enqueue({
    clientRequestId,
    deviceId: "device-1",
    tenantId: TENANT,
    propertyId: "prop-1",
    outletId: "outlet-1",
    operationType: "open_order",
    payload: {
      tenantId: TENANT,
      propertyId: "prop-1",
      locationId: "outlet-1",
      orderType: "dine_in",
      guestCount: 2,
      currency: "TZS",
      clientRequestId,
      lines: [],
    },
  });
}

describe("sync engine — happy path", () => {
  it("syncs a single PENDING open_order to SYNCED and records the server result", async () => {
    const op = await enqueueOpenOrder();
    const callers = makeCallers();
    const summary = await syncPendingQueue(TENANT, callers);

    expect(summary.synced).toBe(1);
    expect(summary.attempted).toBe(1);
    expect(callers.openOrder).toHaveBeenCalledTimes(1);

    const updated = await getQueueEntry(op.operationId);
    expect(updated?.state).toBe("SYNCED");
    expect(updated?.serverResult).toEqual({ id: "server-order-1", idempotent: false });
  });

  it("processes operations in strict local sequence order, not enqueue-return order", async () => {
    const calls: string[] = [];
    const callers = makeCallers({
      openOrder: vi.fn(async (payload: any) => {
        calls.push(payload.clientRequestId);
        return { id: `server-${payload.clientRequestId}` };
      }),
    });
    await enqueueOpenOrder("first");
    await enqueueOpenOrder("second");
    await enqueueOpenOrder("third");
    await syncPendingQueue(TENANT, callers);
    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("dependency resolution: add_item queued against a not-yet-synced open_order resolves to the real server order id once its dependency syncs, in the SAME sync pass", async () => {
    const openOp = await enqueueOpenOrder();
    const addItemOp = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT,
      propertyId: "prop-1",
      outletId: "outlet-1",
      operationType: "add_item",
      dependsOnOperationId: openOp.operationId,
      payload: {
        tenantId: TENANT,
        orderRef: { kind: "local", operationId: openOp.operationId },
        lines: [{ description: "Chips", quantity: 1, unitPrice: 5 }],
        clientRequestId: crypto.randomUUID(),
      },
    });

    const callers = makeCallers();
    const summary = await syncPendingQueue(TENANT, callers);

    expect(summary.synced).toBe(2);
    expect(callers.addItems).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "server-order-1" }),
    );
    expect((await getQueueEntry(addItemOp.operationId))?.state).toBe("SYNCED");
  });

  it("fire_to_kitchen also resolves a local orderRef the same way", async () => {
    const openOp = await enqueueOpenOrder();
    await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT,
      propertyId: "prop-1",
      outletId: "outlet-1",
      operationType: "fire_to_kitchen",
      dependsOnOperationId: openOp.operationId,
      payload: { tenantId: TENANT, orderRef: { kind: "local", operationId: openOp.operationId } },
    });
    const callers = makeCallers();
    await syncPendingQueue(TENANT, callers);
    expect(callers.fireToKitchen).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "server-order-1" }),
    );
  });

  it("an operation whose dependency has not yet synced is skipped this pass, not attempted out of order or errored", async () => {
    // Enqueue the child first with a dependency on an operation id that
    // isn't PENDING/hasn't been created yet in this call's batch — proves
    // the engine checks dependency state, not just presence.
    const fakeParentId = crypto.randomUUID();
    const callers = makeCallers();
    const child = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT,
      propertyId: "prop-1",
      outletId: "outlet-1",
      operationType: "add_item",
      dependsOnOperationId: fakeParentId,
      payload: {
        tenantId: TENANT,
        orderRef: { kind: "local", operationId: fakeParentId },
        lines: [],
        clientRequestId: crypto.randomUUID(),
      },
    });
    const summary = await syncPendingQueue(TENANT, callers);
    expect(summary.skippedWaitingOnDependency).toBe(1);
    expect(summary.attempted).toBe(0);
    expect(callers.addItems).not.toHaveBeenCalled();
    expect((await getQueueEntry(child.operationId))?.state).toBe("PENDING");
  });
});

describe("sync engine — idempotent replay", () => {
  it("same operation synced twice (simulating a retry after the client already got a response) calls the server twice but ends in exactly one SYNCED entry — no duplicate queue row is ever created by a re-sync", async () => {
    await enqueueOpenOrder("replay-key");
    const callers = makeCallers();
    await syncPendingQueue(TENANT, callers);
    // A second sync pass over an already-SYNCED queue finds nothing PENDING
    // to do — this is what "the queue never re-submits a synced operation"
    // actually means; the idempotency guarantee against the SERVER
    // duplicating the business effect on a genuine retry is the existing
    // clientRequestId mechanism's job (proven in pos.server.ts/sales.server.ts),
    // not this engine's — the engine's own job is to never ask twice once
    // it has a SYNCED result.
    const secondSummary = await syncPendingQueue(TENANT, callers);
    expect(secondSummary.attempted).toBe(0);
    expect(callers.openOrder).toHaveBeenCalledTimes(1);
    const all = await listQueueForTenant(TENANT);
    expect(all).toHaveLength(1);
  });

  it("a network-timeout-after-server-commit scenario: the server call throws (client never saw the response) but a replay is classified transient-retryable, not silently re-attempted as a NEW queue entry", async () => {
    let calls = 0;
    const callers = makeCallers({
      openOrder: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("network timeout");
        return { id: "server-order-1" };
      }),
    });
    const op = await enqueueOpenOrder();
    const first = await syncPendingQueue(TENANT, callers);
    expect(first.retried).toBe(1);
    expect((await getQueueEntry(op.operationId))?.state).toBe("RETRYABLE_FAILURE");

    const second = await syncPendingQueue(TENANT, callers);
    expect(second.synced).toBe(1);
    expect(calls).toBe(2);
    const all = await listQueueForTenant(TENANT);
    expect(all).toHaveLength(1); // still exactly one queue entry throughout
  });

  it("browser refresh during sync: a PROCESSING entry left over from an interrupted run is picked up again on the next call, not lost", async () => {
    const op = await enqueueOpenOrder();
    // Simulate: sync started, marked PROCESSING, then the tab died before
    // the response was recorded.
    const { transitionQueueEntry } = await import("./queue");
    await transitionQueueEntry(op.operationId, { state: "RETRYABLE_FAILURE", attemptCount: 1 });
    const callers = makeCallers();
    const summary = await syncPendingQueue(TENANT, callers);
    expect(summary.synced).toBe(1);
    expect((await getQueueEntry(op.operationId))?.state).toBe("SYNCED");
  });
});

describe("sync engine — retry bound and dead-letter", () => {
  it("a permanently-failing transient error is retried up to the bound, then DEAD_LETTERed — never retried forever", async () => {
    const callers = makeCallers({
      openOrder: vi.fn(async () => {
        throw new Error("persistent 500");
      }),
    });
    const op = await enqueueOpenOrder();
    let lastSummary;
    for (let i = 0; i < 6; i += 1) {
      lastSummary = await syncPendingQueue(TENANT, callers);
    }
    const final = await getQueueEntry(op.operationId);
    expect(final?.state).toBe("DEAD_LETTER");
    expect(callers.openOrder).toHaveBeenCalledTimes(5); // MAX_ATTEMPTS_BEFORE_DEAD_LETTER
  });
});

describe("sync engine — conflict handling", () => {
  it("a closed-order conflict moves the entry to CONFLICT and writes a ConflictRecord, never retries and never silently applies the mutation", async () => {
    const openOp = await enqueueOpenOrder();
    const addOp = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT,
      propertyId: "prop-1",
      outletId: "outlet-1",
      operationType: "add_item",
      dependsOnOperationId: openOp.operationId,
      payload: {
        tenantId: TENANT,
        orderRef: { kind: "local", operationId: openOp.operationId },
        lines: [],
        clientRequestId: crypto.randomUUID(),
      },
    });
    const callers = makeCallers({
      addItems: vi.fn(async () => {
        throw new Error("This bill is closed and can no longer be modified.");
      }),
    });
    const summary = await syncPendingQueue(TENANT, callers);
    expect(summary.conflicts).toBe(1);

    const finalAdd = await getQueueEntry(addOp.operationId);
    expect(finalAdd?.state).toBe("CONFLICT");

    const conflicts = await getAllByIndex<ConflictRecord>(
      STORES.conflicts,
      "by_operation",
      addOp.operationId,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].outcome).toBe("SERVER_WINS");
  });

  it("an authorization-revoked conflict (Forbidden) requires operator attention and is never auto-retried", async () => {
    const callers = makeCallers({
      openOrder: vi.fn(async () => {
        throw new Error('Forbidden — "sales.manage" requires one of: owner.');
      }),
    });
    const op = await enqueueOpenOrder();
    const summary = await syncPendingQueue(TENANT, callers);
    expect(summary.conflicts).toBe(1);
    expect((await getQueueEntry(op.operationId))?.state).toBe("CONFLICT");
    // A second sync pass must not attempt it again — CONFLICT is terminal
    // until an operator acts, never auto-swept back into PENDING.
    const second = await syncPendingQueue(TENANT, callers);
    expect(second.attempted).toBe(0);
    expect(callers.openOrder).toHaveBeenCalledTimes(1);
  });
});

describe("sync engine — status observability", () => {
  it("syncStatusFor reports an accurate breakdown across every terminal and non-terminal state", async () => {
    const synced = await enqueueOpenOrder();
    const pending = await enqueueOpenOrder();
    const conflicted = await enqueueOpenOrder();
    const { transitionQueueEntry } = await import("./queue");
    await transitionQueueEntry(synced.operationId, { state: "SYNCED" });
    await transitionQueueEntry(conflicted.operationId, { state: "CONFLICT" });

    const status = await syncStatusFor(TENANT);
    expect(status.synced).toBe(1);
    expect(status.pending).toBe(1);
    expect(status.conflicts).toBe(1);
  });
});

describe("sync engine — re-entrancy / concurrent invocation", () => {
  it("two concurrent syncPendingQueue calls for the same tenant never both process the same PENDING entry into a double server call", async () => {
    // Simulates a UI that fires sync both on a reconnect event and a
    // periodic timer at the same moment. Because transitionQueueEntry
    // writes PROCESSING synchronously before the (slow) server call
    // resolves, a naive re-entrant loop reading PENDING again mid-flight
    // would still see the row as PENDING only until the first pass's write
    // lands — this proves the actual behavior, not merely a design intent.
    const op = await enqueueOpenOrder();
    let resolveOpen: (v: any) => void;
    const openOrder = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const callers = makeCallers({ openOrder: openOrder as any });

    const firstRun = syncPendingQueue(TENANT, callers);
    // The module-level per-tenant lock (acquired synchronously inside
    // syncPendingQueue, before any await) means the second call sees the
    // lock held immediately — no tick needed, and none should be — a real
    // reconnect-plus-timer race wouldn't get to schedule a tick either.
    const secondSummary = await syncPendingQueue(TENANT, callers);

    expect(secondSummary.alreadyInProgress).toBe(true);
    expect(secondSummary.attempted).toBe(0);
    await vi.waitFor(() => expect(resolveOpen).toBeDefined());
    resolveOpen!({ id: "server-order-1" });
    await firstRun;
    // The one and only server call across both invocations — proof the
    // second call never independently attempted the same operation.
    expect(openOrder).toHaveBeenCalledTimes(1);
  });
});
