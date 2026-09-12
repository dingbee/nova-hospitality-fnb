/**
 * Real IndexedDB semantics via fake-indexeddb (a spec-accurate
 * implementation, not a hand-rolled mock) — proves durability, versioned
 * schema, and index-based tenant scoping against the actual algorithm the
 * browser runs, not an approximation of it.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  del,
  DB_NAME,
  get,
  getAll,
  getAllByIndex,
  isStorageAvailable,
  put,
  resetDbConnectionForTests,
  STORES,
} from "./db";

beforeEach(async () => {
  resetDbConnectionForTests();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

afterEach(() => {
  resetDbConnectionForTests();
});

describe("IndexedDB durable storage", () => {
  it("persists a value across a simulated connection reopen (refresh)", async () => {
    await put(STORES.device, { id: "device", deviceId: "d-1" });
    resetDbConnectionForTests(); // simulates a fresh page load re-opening the same on-disk DB
    const value = await get<{ id: string; deviceId: string }>(STORES.device, "device");
    expect(value?.deviceId).toBe("d-1");
  });

  it("versioned schema creates every required store on first open", async () => {
    await put(STORES.device, { id: "device", deviceId: "d-1" });
    // If any store from the upgrade handler were missing, this would throw
    // "object store not found" rather than resolve.
    await Promise.all(
      Object.values(STORES).map((store) =>
        expect(getAll(store)).resolves.toBeDefined(),
      ),
    );
  });

  it("get returns undefined for a missing key rather than throwing", async () => {
    const value = await get(STORES.device, "does-not-exist");
    expect(value).toBeUndefined();
  });

  it("del actually removes the record", async () => {
    await put(STORES.queue, { operationId: "op-1", tenantId: "t1" });
    await del(STORES.queue, "op-1");
    expect(await get(STORES.queue, "op-1")).toBeUndefined();
  });

  it("getAllByIndex only returns rows matching the index query — real tenant scoping, not a filter the caller could forget", async () => {
    await put(STORES.queue, { operationId: "op-1", tenantId: "tenant-a" });
    await put(STORES.queue, { operationId: "op-2", tenantId: "tenant-b" });
    await put(STORES.queue, { operationId: "op-3", tenantId: "tenant-a" });

    const forA = await getAllByIndex<{ operationId: string }>(
      STORES.queue,
      "by_tenant",
      "tenant-a",
    );
    expect(forA.map((r) => r.operationId).sort()).toEqual(["op-1", "op-3"]);

    const forB = await getAllByIndex<{ operationId: string }>(
      STORES.queue,
      "by_tenant",
      "tenant-b",
    );
    expect(forB.map((r) => r.operationId)).toEqual(["op-2"]);
  });

  it("isStorageAvailable reports true when IndexedDB opens successfully", async () => {
    expect(await isStorageAvailable()).toBe(true);
  });

  it("isStorageAvailable reports false (never throws) when the environment has no indexedDB", async () => {
    const real = (globalThis as any).indexedDB;
    resetDbConnectionForTests();
    // @ts-expect-error simulating a locked-down / no-IndexedDB runtime
    delete (globalThis as any).indexedDB;
    try {
      expect(await isStorageAvailable()).toBe(false);
    } finally {
      (globalThis as any).indexedDB = real;
      resetDbConnectionForTests();
    }
  });
});
