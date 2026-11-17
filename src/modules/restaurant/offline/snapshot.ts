/**
 * P10 Phase 6 — offline operational snapshot.
 *
 * A read-only cache of exactly what a device needs to keep taking orders
 * while offline: the till board (tables + their live bills) and the
 * sellable catalogue (menu items, prices, modifiers) for one outlet. Both
 * come from the *same* existing server functions the online POS already
 * uses (`posBoardFn`/`posCatalogFn`) — this module fetches them, stamps the
 * required provenance metadata, and stores the result. It never derives its
 * own view of prices/tax/availability; whatever `posCatalog` returns is
 * what gets used, both live and offline, so there is exactly one source of
 * truth for "what does this item cost right now."
 */
import { get, put, STORES } from "./db";

export interface SnapshotScope {
  tenantId: string;
  propertyId: string | null;
  outletId: string;
}

export interface OperationalSnapshot {
  scopeKey: string;
  tenantId: string;
  propertyId: string | null;
  outletId: string;
  schemaVersion: 1;
  generatedAt: string;
  /** Snapshots older than this are still usable (never silently treated as
   * live — see isStale below) but the UI must show a stale warning. */
  staleAfterMs: number;
  board: unknown;
  catalog: unknown;
}

const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes — a shift-length assumption, documented in docs/p10-offline-operations.md

function scopeKey(scope: SnapshotScope): string {
  return `${scope.tenantId}:${scope.outletId}`;
}

export async function getCachedSnapshot(
  scope: SnapshotScope,
): Promise<OperationalSnapshot | undefined> {
  const record = await get<OperationalSnapshot>(STORES.snapshot, scopeKey(scope));
  // Tenant isolation enforced here too, not just trusted from the caller's
  // scope key construction — a corrupted/tampered local key must not be
  // able to return another tenant's snapshot.
  if (record && record.tenantId !== scope.tenantId) return undefined;
  return record;
}

/** Writes a freshly-fetched snapshot. Callers pass the raw results of
 * `posBoardFn`/`posCatalogFn` — this function does not fetch them itself,
 * so it has no network dependency and is trivially unit-testable. */
export async function storeSnapshot(
  scope: SnapshotScope,
  board: unknown,
  catalog: unknown,
): Promise<OperationalSnapshot> {
  const snapshot: OperationalSnapshot = {
    scopeKey: scopeKey(scope),
    tenantId: scope.tenantId,
    propertyId: scope.propertyId,
    outletId: scope.outletId,
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    staleAfterMs: STALE_AFTER_MS,
    board,
    catalog,
  };
  await put(STORES.snapshot, snapshot);
  return snapshot;
}

export function isStale(snapshot: OperationalSnapshot, now = Date.now()): boolean {
  return now - new Date(snapshot.generatedAt).getTime() > snapshot.staleAfterMs;
}

export function snapshotAgeMs(snapshot: OperationalSnapshot, now = Date.now()): number {
  return now - new Date(snapshot.generatedAt).getTime();
}
