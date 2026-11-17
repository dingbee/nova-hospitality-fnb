import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, DB_NAME } from "./db";
import { getCachedSnapshot, isStale, snapshotAgeMs, storeSnapshot } from "./snapshot";

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

const SCOPE_A = { tenantId: "tenant-a", propertyId: "prop-a", outletId: "outlet-a" };
const SCOPE_B = { tenantId: "tenant-b", propertyId: "prop-b", outletId: "outlet-b" };

describe("offline operational snapshot", () => {
  it("returns undefined when nothing has been cached for this scope", async () => {
    expect(await getCachedSnapshot(SCOPE_A)).toBeUndefined();
  });

  it("stores and retrieves the board/catalog exactly as given — never derives its own view of prices/availability", async () => {
    const board = { tables: [{ id: "t1" }] };
    const catalog = { items: [{ id: "i1", price: 10 }] };
    await storeSnapshot(SCOPE_A, board, catalog);
    const cached = await getCachedSnapshot(SCOPE_A);
    expect(cached?.board).toEqual(board);
    expect(cached?.catalog).toEqual(catalog);
  });

  it("every required metadata field is present: generatedAt, schemaVersion, tenant/property/outlet scope", async () => {
    const snapshot = await storeSnapshot(SCOPE_A, {}, {});
    expect(snapshot.generatedAt).toBeTruthy();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.tenantId).toBe(SCOPE_A.tenantId);
    expect(snapshot.propertyId).toBe(SCOPE_A.propertyId);
    expect(snapshot.outletId).toBe(SCOPE_A.outletId);
    expect(snapshot.staleAfterMs).toBeGreaterThan(0);
  });

  it("tenant isolation: a snapshot for Tenant A is never returned when reading with a tampered scope key that claims Tenant B's tenantId but Tenant A's outlet", async () => {
    await storeSnapshot(SCOPE_A, { board: "A" }, {});
    // Same outletId, different (claimed) tenantId — the scopeKey happens to
    // collide only if outletId is treated as globally unique, which it
    // isn't; this proves the tenantId cross-check inside getCachedSnapshot
    // actually runs, not just the key lookup.
    const tampered = { tenantId: SCOPE_B.tenantId, propertyId: null, outletId: SCOPE_A.outletId };
    const result = await getCachedSnapshot(tampered);
    expect(result).toBeUndefined();
  });

  it("two different outlets in the same tenant get independent snapshots", async () => {
    await storeSnapshot(SCOPE_A, { board: "A" }, {});
    await storeSnapshot({ ...SCOPE_A, outletId: "outlet-z" }, { board: "Z" }, {});
    expect((await getCachedSnapshot(SCOPE_A))?.board).toEqual({ board: "A" });
    expect((await getCachedSnapshot({ ...SCOPE_A, outletId: "outlet-z" }))?.board).toEqual({
      board: "Z",
    });
  });

  it("re-storing for the same scope overwrites the previous snapshot (one authoritative snapshot per scope, not an unbounded history)", async () => {
    await storeSnapshot(SCOPE_A, { board: "old" }, {});
    await storeSnapshot(SCOPE_A, { board: "new" }, {});
    expect((await getCachedSnapshot(SCOPE_A))?.board).toEqual({ board: "new" });
  });

  it("isStale is false right after storing, true once staleAfterMs has elapsed — never claims fresh data is live past its own declared window", async () => {
    // Real timers throughout: fake-indexeddb's internal scheduling needs a
    // real event loop, and only isStale's arithmetic (pure JS, no IDB call)
    // needs a controlled "now" — passed explicitly as its second argument
    // rather than faking global time.
    const snapshot = await storeSnapshot(SCOPE_A, {}, {});
    const generatedAtMs = new Date(snapshot.generatedAt).getTime();
    expect(isStale(snapshot, generatedAtMs)).toBe(false);
    expect(isStale(snapshot, generatedAtMs + snapshot.staleAfterMs + 1)).toBe(true);
  });

  it("snapshotAgeMs reports elapsed time accurately", async () => {
    const snapshot = await storeSnapshot(SCOPE_A, {}, {});
    const generatedAtMs = new Date(snapshot.generatedAt).getTime();
    expect(snapshotAgeMs(snapshot, generatedAtMs + 5000)).toBe(5000);
  });
});
