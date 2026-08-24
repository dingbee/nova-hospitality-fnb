/**
 * Server-authoritative production-station resolution.
 *
 * Mirrors the pricing rule already enforced in `insertLines`: a client (the
 * till, the bar POS, or a direct API call) may *propose* a station, but a
 * proposal is never authoritative. The server derives the final station from
 * the product's own catalogue configuration, then a category/beverage
 * classification fallback, then a tenant-scoped lane default — never from
 * whatever the client sent.
 *
 * Pure and DB-free by design: `sales.server.ts` fetches the rows, this module
 * decides. That split is what makes the routing decision unit-testable
 * without a Supabase client.
 */

export type StationRow = { id: string; stationType: string | null };

export type ProductStationInfo = {
  /** The product's own configured station (`restaurant_products.station_id`), when set. */
  stationId: string | null;
  /** True when the product's category classifies as a beverage. */
  isBeverage: boolean;
};

/**
 * Resolves the final station for a catalogued line (one with a menu item /
 * product behind it). The client-proposed station is not a parameter here on
 * purpose: for a catalogued item it is never consulted.
 */
export function resolveCataloguedLineStation(
  product: ProductStationInfo | null,
  stations: readonly StationRow[],
  barStationTypes: readonly string[],
): string | null {
  // 1. Product station wins outright — but only if it still belongs to this
  //    tenant's own station list (a stale or foreign id falls through).
  if (product?.stationId) {
    const configured = stations.find((s) => s.id === product.stationId);
    if (configured) return configured.id;
  }

  // 2. Category/beverage classification → the tenant's lane default.
  const barTypes = new Set(barStationTypes);
  const lane = product?.isBeverage
    ? stations.find((s) => s.stationType && barTypes.has(s.stationType))
    : stations.find((s) => !s.stationType || !barTypes.has(s.stationType));
  return lane?.id ?? null;
}

/**
 * A client-proposed station is only ever honoured for a non-catalogued
 * ("open") item — one with no menu item / product behind it, so there is no
 * catalogue configuration to derive from. Even then, the proposal is only
 * accepted when it names a real station belonging to this tenant; anything
 * else (a foreign-tenant id, a stale id, a fabricated one) resolves to
 * "unassigned" rather than being written through.
 */
export function resolveOpenItemStation(
  proposedStationId: string | null | undefined,
  stations: readonly StationRow[],
): string | null {
  if (!proposedStationId) return null;
  return stations.some((s) => s.id === proposedStationId) ? proposedStationId : null;
}

/**
 * The till's "send to production" label, derived from the actual stations
 * the pending lines will route to (or already have, once written) — never
 * hardcoded. A cart or unsent-item set that is bar-only says "bar", kitchen-only
 * says "kitchen", and a genuine mix says both, so the label can never claim a
 * drink is headed to the kitchen.
 */
export function sendToStationLabel(
  pendingStationTypes: readonly (string | null | undefined)[],
  barStationTypes: readonly string[],
): string {
  const barTypes = new Set(barStationTypes);
  const hasBar = pendingStationTypes.some((t) => Boolean(t) && barTypes.has(t as string));
  const hasNonBar = pendingStationTypes.some((t) => !t || !barTypes.has(t));
  if (hasBar && hasNonBar) return "Send to kitchen & bar";
  if (hasBar) return "Send to bar";
  return "Send to kitchen";
}
