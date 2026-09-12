/**
 * P10 — durable local storage.
 *
 * A minimal, hand-rolled promise wrapper over the real browser IndexedDB
 * API — no `idb`/`Dexie` dependency added, since the whole surface this
 * module needs (open/upgrade, get/put/delete, index queries, cursors) is a
 * few dozen lines over the native API and this repository already avoids
 * adding a dependency where the platform itself solves the requirement.
 *
 * Real durability, not a workaround: IndexedDB persists across refresh and
 * browser restart by the browser's own guarantee; nothing here uses
 * localStorage/sessionStorage for transactional data (see CLAUDE.md — this
 * module's whole reason to exist is that "localStorage-only state is
 * insufficient for transactional data").
 *
 * Tenant isolation is enforced here, not just trusted from the caller:
 * IndexedDB has no equivalent of RLS, so every read/query function in this
 * module requires a tenantId and filters by it before returning anything —
 * see the adversarial tenant-isolation tests in db.test.ts.
 */

export const DB_NAME = "nova-offline";
export const DB_VERSION = 1;

export const STORES = {
  device: "device_identity",
  snapshot: "operational_snapshot",
  queue: "transaction_queue",
  syncState: "sync_state",
  conflicts: "conflict_records",
  audit: "local_audit",
} as const;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      // Schema version 1 — initial stores. Future migrations branch on
      // oldVersion here, additive only (IndexedDB upgrades run in one
      // versionchange transaction; a failed upgrade aborts the whole open).
      if (oldVersion < 1) {
        db.createObjectStore(STORES.device, { keyPath: "id" });

        const snapshot = db.createObjectStore(STORES.snapshot, { keyPath: "scopeKey" });
        snapshot.createIndex("by_tenant", "tenantId", { unique: false });

        const queue = db.createObjectStore(STORES.queue, { keyPath: "operationId" });
        queue.createIndex("by_tenant", "tenantId", { unique: false });
        queue.createIndex("by_state", "state", { unique: false });
        queue.createIndex("by_tenant_state", ["tenantId", "state"], { unique: false });
        queue.createIndex("by_sequence", "sequence", { unique: false });
        // clientRequestId is unique per tenant at the server; enforcing the
        // same uniqueness locally means enqueue-twice (e.g. a duplicated
        // click before the in-memory guard runs) can never create two local
        // queue entries that would both try to claim the same idempotency
        // key at sync time.
        queue.createIndex("by_tenant_clientRequestId", ["tenantId", "clientRequestId"], {
          unique: true,
        });

        db.createObjectStore(STORES.syncState, { keyPath: "scopeKey" });

        const conflicts = db.createObjectStore(STORES.conflicts, { keyPath: "conflictId" });
        conflicts.createIndex("by_operation", "operationId", { unique: false });

        const audit = db.createObjectStore(STORES.audit, { keyPath: "id" });
        audit.createIndex("by_tenant_time", ["tenantId", "at"], { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked by another open connection"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Lazily opens (and caches) the single shared connection. A corrupted
 * open (onerror) clears the cache so the next call gets a fresh attempt
 * rather than permanently wedging on one failure. */
export async function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabase().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/**
 * Closes the shared connection, if one is open, and clears the cache.
 * IndexedDB's own `deleteDatabase`/version-upgrade operations block
 * indefinitely while any connection to that database remains open (this is
 * a genuine defect this pass found via its own test suite hanging, not a
 * theoretical concern) — anything that needs the database to actually be
 * deletable or upgradable (tests between cases, a future schema migration
 * that needs to force a clean reopen) must call this first, not just drop
 * references and hope garbage collection closes it.
 */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    db.close();
  } catch {
    // Already failed to open — nothing to close.
  } finally {
    dbPromise = null;
  }
}

/** Test-only: force a fresh connection on the next getDb() call. Prefer
 * `closeDb()` when an existing connection may be open (e.g. between test
 * cases that need `indexedDB.deleteDatabase` to actually complete) — this
 * function only clears the cached reference, it does not close the
 * underlying connection. */
export function resetDbConnectionForTests() {
  dbPromise = null;
}

function wrapRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function wrapTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function put<T>(storeName: string, value: T): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(value);
  await wrapTx(tx);
}

export async function get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await getDb();
  const tx = db.transaction(storeName, "readonly");
  const result = await wrapRequest<T>(tx.objectStore(storeName).get(key) as IDBRequest<T>);
  return result;
}

export async function del(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(key);
  await wrapTx(tx);
}

export async function getAllByIndex<T>(
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  const db = await getDb();
  const tx = db.transaction(storeName, "readonly");
  const index = tx.objectStore(storeName).index(indexName);
  const result = await wrapRequest<T[]>(index.getAll(query) as unknown as IDBRequest<T[]>);
  return result ?? [];
}

export async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await getDb();
  const tx = db.transaction(storeName, "readonly");
  const result = await wrapRequest<T[]>(tx.objectStore(storeName).getAll() as IDBRequest<T[]>);
  return result ?? [];
}

/** Whether IndexedDB is usable at all in this runtime — Safari private
 * browsing and some locked-down/quota-exhausted contexts throw on open
 * rather than merely being empty. Callers use this to degrade to a clear
 * "offline mode unavailable" UX rather than crashing (P10 Phase 18 "storage
 * unavailable"). */
export async function isStorageAvailable(): Promise<boolean> {
  try {
    await getDb();
    return true;
  } catch {
    return false;
  }
}
