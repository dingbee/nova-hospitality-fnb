/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * The single authoritative tenant central-store resolution.
 *
 * The central store ("Main Store") is configured as the tenant's one
 * `restaurant_locations` row with `scope = 'tenant'` (migration 0110). Its
 * interpretation lives in exactly one place — the database function
 * `restaurant_central_store_resolution` (migration 0157) — and every server
 * consumer (purchasing, receiving, transfers, the Main Store workspace)
 * resolves it through this module. Nothing infers "central store" from a
 * NULL property id, a name, or a UI badge.
 */

type Sb = any;

export type CentralStoreResolution =
  | "active"
  | "not_configured"
  | "inactive"
  | "invalid"
  | "ambiguous";

export interface CentralStoreStatus {
  resolution: CentralStoreResolution;
  /** True only when the store is configured, valid and active: central-store mode. */
  active: boolean;
  locationId: string | null;
  name: string | null;
  code: string | null;
  locationStatus: string | null;
  detail: string | null;
}

export class CentralStoreResolutionError extends Error {
  readonly code = "central_store_unresolved";
  constructor(
    message: string,
    readonly resolution: CentralStoreResolution,
  ) {
    super(message);
    this.name = "CentralStoreResolutionError";
  }
}

export async function getCentralStoreStatus(sb: Sb, tenantId: string): Promise<CentralStoreStatus> {
  const { data, error } = await sb.rpc("restaurant_central_store_resolution", {
    _tenant_id: tenantId,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) {
    throw new CentralStoreResolutionError(
      "Central-store configuration could not be resolved.",
      "invalid",
    );
  }
  const resolution = String(row.resolution) as CentralStoreResolution;
  return {
    resolution,
    active: resolution === "active",
    locationId: row.location_id ?? null,
    name: row.location_name ?? null,
    code: row.location_code ?? null,
    locationStatus: row.location_status ?? null,
    detail: row.detail ?? null,
  };
}

/**
 * Central-store mode decision for a workflow.
 *
 * - `active`          → returns the store (central-store mode is on).
 * - `not_configured`  → returns null (property-level workflows apply).
 * - anything else     → throws: a configured-but-broken central store must
 *   never silently fall back to property mode or to an unassigned record.
 */
export async function resolveCentralStore(
  sb: Sb,
  tenantId: string,
): Promise<CentralStoreStatus | null> {
  const status = await getCentralStoreStatus(sb, tenantId);
  if (status.resolution === "active") return status;
  if (status.resolution === "not_configured") return null;
  throw new CentralStoreResolutionError(
    `CENTRAL_STORE_UNRESOLVED — ${status.detail ?? `central store is ${status.resolution}`}. Fix the Main Store configuration before raising central purchasing.`,
    status.resolution,
  );
}

/** Same as resolveCentralStore, but a missing central store is also an error. */
export async function requireCentralStore(sb: Sb, tenantId: string): Promise<CentralStoreStatus> {
  const store = await resolveCentralStore(sb, tenantId);
  if (!store) {
    throw new CentralStoreResolutionError(
      "CENTRAL_STORE_NOT_CONFIGURED — this tenant has no active Main Store.",
      "not_configured",
    );
  }
  return store;
}
