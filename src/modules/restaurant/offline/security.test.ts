/* eslint-disable @typescript-eslint/no-explicit-any -- test-only mock payloads/results are untyped at this boundary. */
/**
 * P10 Phase 17 — adversarial offline security testing.
 *
 * The single governing property under test throughout this file: the
 * server remains authoritative. Local storage (the queue, the snapshot,
 * the device identity) is never a trust boundary — every test here either
 * (a) proves the local layer performs no authorization/pricing/identity
 * decision of its own to tamper with, because there is none to tamper
 * with, or (b) proves that when a mocked server call rejects a malicious
 * or stale request, the sync engine treats that as a conflict/failure, not
 * as success.
 *
 * Tenant/property/outlet isolation, price/tax non-authority, and the
 * closed-order/Forbidden conflict paths are also exercised in
 * queue.test.ts, conflict.test.ts and syncEngine.test.ts as part of their
 * own normal-behavior coverage; this file is the dedicated, named
 * adversarial pass the mission's Phase 17 checklist asks for, and does not
 * re-assert what those files already prove — it covers what they don't.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, DB_NAME, put, STORES } from "./db";
import { enqueue, getQueueEntry, listQueueForTenant } from "./queue";
import { syncPendingQueue, type SyncCallers } from "./syncEngine";
import type { QueuedOperation } from "./contracts";

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

function makeCallers(overrides: Partial<SyncCallers> = {}): SyncCallers {
  return {
    openOrder: vi.fn(async () => ({ id: "server-order-1" })),
    addItems: vi.fn(async () => ({ items: [] })),
    fireToKitchen: vi.fn(async () => ({ fired: 1 })),
    ...overrides,
  };
}

describe("Phase 17 — structural non-authority (nothing to tamper with locally)", () => {
  it("QueuedOperation carries no role/permission/price-authority field the sync engine could read instead of asking the server", async () => {
    const op = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: "prop-1",
      outletId: "outlet-1",
      operationType: "open_order",
      payload: { lines: [] },
    });
    // The fields the record has are a closed, known set — a role, an
    // authorization decision, or a "trusted price" field is not among
    // them. This is a structural guarantee, not a runtime check: there is
    // no code path anywhere in this module that reads an authorization
    // decision off a QueuedOperation, because no such field exists to read.
    expect(Object.keys(op).sort()).toEqual(
      [
        "operationId",
        "clientRequestId",
        "deviceId",
        "tenantId",
        "propertyId",
        "outletId",
        "operationType",
        "payload",
        "createdAt",
        "sequence",
        "attemptCount",
        "state",
        "lastAttemptAt",
        "failureReason",
        "retryable",
        "serverResult",
        "dependsOnOperationId",
      ].sort(),
    );
  });

  it("a payload with a locally-inflated price/tax is forwarded verbatim to the server call, never adjusted or trusted locally — pricing authority is entirely sales.server.ts's insertLines, which re-derives price from the catalogue for any catalogued line regardless of what the client sent", async () => {
    const tamperedPayload = {
      tenantId: TENANT_A,
      orderRef: { kind: "server" as const, orderId: "order-1" },
      lines: [{ menuItemId: "item-1", quantity: 1, unitPrice: 0.01, description: "Steak" }],
      clientRequestId: crypto.randomUUID(),
    };
    await enqueue({
      clientRequestId: tamperedPayload.clientRequestId,
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: null,
      outletId: null,
      operationType: "add_item",
      payload: tamperedPayload,
    });
    const addItems = vi.fn(async (p: any) => ({ items: [], received: p }));
    await syncPendingQueue(TENANT_A, makeCallers({ addItems }));
    // The sync engine's job is transport, not pricing — it passes exactly
    // what was queued. The actual defense (server re-derives price from
    // the catalogue for anything with a menuItemId) lives in
    // sales.server.ts's insertLines and is that file's own responsibility,
    // proven there — this test only proves the offline layer doesn't
    // short-circuit or "helpfully" adjust the tampered value before
    // forwarding it, which would defeat that server-side defense.
    expect(addItems).toHaveBeenCalledWith(
      expect.objectContaining({ lines: tamperedPayload.lines }),
    );
  });
});

describe("Phase 17 — tenant/device replay boundaries", () => {
  it("the same clientRequestId queued for two different tenants produces two independent queue entries, never conflated into one", async () => {
    const clientRequestId = "cross-tenant-key";
    const opA = await enqueue({
      clientRequestId,
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: {},
    });
    const opB = await enqueue({
      clientRequestId,
      deviceId: "device-1",
      tenantId: TENANT_B,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: {},
    });
    expect(opA.operationId).not.toBe(opB.operationId);
    // Each tenant's sync pass only ever touches its own queue.
    const forA = await listQueueForTenant(TENANT_A);
    const forB = await listQueueForTenant(TENANT_B);
    expect(forA.map((o) => o.operationId)).toEqual([opA.operationId]);
    expect(forB.map((o) => o.operationId)).toEqual([opB.operationId]);
  });

  it("syncing Tenant A never calls the server for Tenant B's queued operations, even when both exist locally on the same device", async () => {
    await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: { marker: "A" },
    });
    await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT_B,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: { marker: "B" },
    });
    const openOrder = vi.fn(async (p: any) => ({ id: "server-order", seen: p.marker }));
    await syncPendingQueue(TENANT_A, makeCallers({ openOrder }));
    expect(openOrder).toHaveBeenCalledTimes(1);
    expect(openOrder).toHaveBeenCalledWith(expect.objectContaining({ marker: "A" }));
  });

  it("a device identity persisted for Tenant A does not change or get consulted when syncing Tenant B — the queue's own tenantId field is what scopes every sync pass, not the device record", async () => {
    // registerDevice/getDeviceIdentity are entirely separate from
    // syncPendingQueue's tenant scoping — this proves syncPendingQueue
    // never reads device.ts's stored identity at all, so a device
    // "registered" for one tenant cannot influence which tenant's queue a
    // sync call touches; that is decided purely by the tenantId argument
    // the caller (application code, itself gated by the real signed-in
    // session) passes in.
    const module = await import("./device");
    const registerSpy = vi.spyOn(module, "getDeviceIdentity");
    await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: {},
    });
    await syncPendingQueue(TENANT_A, makeCallers());
    expect(registerSpy).not.toHaveBeenCalled();
    registerSpy.mockRestore();
  });
});

describe("Phase 17 — tampered/corrupted local records never escalate privilege or crash the batch", () => {
  it("a queue record whose tenantId was rewritten directly in storage (simulating a tampered local DB) is still just data the server independently re-authorizes — a mocked Forbidden response is treated as a conflict, never as success", async () => {
    const op = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: { tenantId: TENANT_A },
    });
    // Directly tamper the stored record's tenantId field — this bypasses
    // enqueue() entirely, simulating direct IndexedDB manipulation (e.g. via
    // devtools) or a corrupted write, not going through this module's own
    // API.
    const tampered: QueuedOperation = {
      ...op,
      tenantId: TENANT_B,
      payload: { tenantId: TENANT_B },
    };
    await put(STORES.queue, tampered);

    const openOrder = vi.fn(async () => {
      throw new Error("Forbidden — you do not belong to this restaurant tenant.");
    });
    const summary = await syncPendingQueue(TENANT_B, makeCallers({ openOrder }));
    expect(summary.conflicts).toBe(1);
    const final = await getQueueEntry(op.operationId);
    expect(final?.state).toBe("CONFLICT");
    // Never marked SYNCED — the tampered operation gained no authority.
    expect(final?.state).not.toBe("SYNCED");
  });

  it("one corrupted/malformed queue entry (payload missing fields the handler expects) fails safely without poisoning the rest of the batch", async () => {
    const badOp = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: null, // malformed — a real handler would throw reading into it
    });
    const goodOp = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: { fine: true },
    });
    const openOrder = vi.fn(async (p: any) => {
      if (p === null) throw new TypeError("Cannot read properties of null");
      return { id: "server-order-ok" };
    });
    const summary = await syncPendingQueue(TENANT_A, makeCallers({ openOrder }));
    expect(summary.attempted).toBe(2);
    expect((await getQueueEntry(goodOp.operationId))?.state).toBe("SYNCED");
    // The bad one fails safely (retryable classification for an
    // unrecognized error) rather than crashing syncPendingQueue outright —
    // proven by the fact goodOp still got processed in the same pass.
    const badFinal = await getQueueEntry(badOp.operationId);
    expect(["RETRYABLE_FAILURE", "DEAD_LETTER"]).toContain(badFinal?.state);
  });

  it("syncPendingQueue never throws even when every operation in the batch fails — the caller always gets a summary back, not an unhandled rejection", async () => {
    await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: {},
    });
    const openOrder = vi.fn(async () => {
      throw new Error("total server outage");
    });
    await expect(syncPendingQueue(TENANT_A, makeCallers({ openOrder }))).resolves.toBeTruthy();
  });
});

describe("Phase 17 — stale/revoked authorization never auto-succeeds", () => {
  it("a session that expired between queueing and syncing is not this module's problem to detect — the server's own requireSupabaseAuth check does (real message: 'Unauthorized: Invalid token'), and the sync engine classifies that rejection as requiring an operator, never retrying it as if it were a network blip", async () => {
    const op = await enqueue({
      clientRequestId: crypto.randomUUID(),
      deviceId: "device-1",
      tenantId: TENANT_A,
      propertyId: null,
      outletId: null,
      operationType: "open_order",
      payload: {},
    });
    const openOrder = vi.fn(async () => {
      throw new Error("Unauthorized: Invalid token");
    });
    const summary = await syncPendingQueue(TENANT_A, makeCallers({ openOrder }));
    expect(summary.synced).toBe(0);
    expect(summary.conflicts).toBe(1);
    expect((await getQueueEntry(op.operationId))?.state).toBe("CONFLICT");
    // Never auto-retried on a second pass — CONFLICT is terminal until an
    // operator acts (re-authenticate, then explicitly requeue/retry).
    const second = await syncPendingQueue(TENANT_A, makeCallers({ openOrder }));
    expect(second.attempted).toBe(0);
    expect(openOrder).toHaveBeenCalledTimes(1);
  });

  it("every one of requireSupabaseAuth's real rejection messages is classified as REQUIRES_OPERATOR, not a transient retry", async () => {
    const { classifyOutcome } = await import("./conflict");
    const realMessages = [
      "Unauthorized: No request headers available",
      "Unauthorized: No authorization header provided",
      "Unauthorized: Only Bearer tokens are supported",
      "Unauthorized: No token provided",
      "Unauthorized: Invalid token",
      "Unauthorized: No user ID found in token",
    ];
    for (const message of realMessages) {
      const result = classifyOutcome("open_order", { error: new Error(message) });
      expect(result.outcome).toBe("REQUIRES_OPERATOR");
      expect(result.retryable).toBe(false);
    }
  });
});
