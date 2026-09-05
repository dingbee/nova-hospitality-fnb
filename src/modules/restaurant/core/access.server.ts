/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Server-side tenant + property guards. Server-only (filename is import-protected).
 *
 * RLS is the enforcement point of last resort (see migration
 * 0027_property_scope.sql — restaurant_can_read_scoped/restaurant_can_write_scoped
 * back the same tenant/property model these guards implement); these guards
 * fail fast with readable errors and stop a caller from even attempting a
 * cross-tenant or cross-property write.
 *
 * Property scope model: a `restaurant_members` row with `property_id = null`
 * is a tenant-wide grant for that role (owner/GM-style oversight); a row
 * with `property_id` set is scoped to that property only. A caller may hold
 * several rows — some tenant-wide, some property-scoped, even the same role
 * at two different properties. `canAccessProperty` is the single place that
 * decides whether a resource's property is covered by the caller's grants;
 * every property-aware check in this module is built on it.
 */
import type { RestaurantRole } from "./contracts";
import { rolesForCapability, type RestaurantCapability } from "./permissions";

type Sb = any;

/** One membership grant: a role, and the property it applies to (null = tenant-wide). */
export interface MemberGrant {
  role: RestaurantRole;
  propertyId: string | null;
}

/** A resource's own scope, when it has one. Both fields are optional/nullable:
 * omitting a field, or passing null, means "this resource has no such scope
 * to check" — never "deny". Only a caller who lacks *any* matching grant is denied. */
export interface ResourceScope {
  propertyId?: string | null;
  locationId?: string | null;
}

export async function isPlatformAdmin(supabase: Sb, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_any_role", {
    _user_id: userId,
    _roles: ["owner", "admin", "manager"],
  });
  if (error) return false;
  return Boolean(data);
}

/** Every membership grant this user holds in this tenant, role AND property. */
export async function memberGrantsInTenant(
  supabase: Sb,
  userId: string,
  tenantId: string,
): Promise<MemberGrant[]> {
  const { data } = await supabase
    .from("restaurant_members")
    .select("role, property_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);
  return (data ?? []).map((r: any) => ({
    role: r.role as RestaurantRole,
    propertyId: r.property_id ?? null,
  }));
}

/**
 * Backward-compatible role list — unchanged shape/behaviour for every caller
 * that only needs "which roles does this user hold in this tenant", not
 * which property each one applies to.
 */
export async function rolesInTenant(
  supabase: Sb,
  userId: string,
  tenantId: string,
): Promise<RestaurantRole[]> {
  const grants = await memberGrantsInTenant(supabase, userId, tenantId);
  return [...new Set(grants.map((g) => g.role))];
}

/** Does this one grant cover the given property? (Undefined/null propertyId = nothing to check.) */
function grantCoversProperty(grant: MemberGrant, propertyId: string | null | undefined): boolean {
  if (propertyId === undefined || propertyId === null) return true;
  return grant.propertyId === null || grant.propertyId === propertyId;
}

/**
 * The caller's full authorization scope in one tenant: whether they're a
 * platform admin (bypasses everything), and every membership grant they
 * hold. Resolve this once per request and pass it to canAccessProperty /
 * canAccessLocation rather than re-querying membership per check.
 */
export interface TenantScope {
  tenantId: string;
  platformAdmin: boolean;
  grants: MemberGrant[];
}

export async function getTenantScope(
  supabase: Sb,
  userId: string,
  tenantId: string,
): Promise<TenantScope> {
  const platformAdmin = await isPlatformAdmin(supabase, userId);
  const grants = platformAdmin ? [] : await memberGrantsInTenant(supabase, userId, tenantId);
  return { tenantId, platformAdmin, grants };
}

/** Does this caller's scope cover the given property? null/undefined propertyId = not scoped, always allowed. */
export function canAccessProperty(
  scope: TenantScope,
  propertyId: string | null | undefined,
): boolean {
  if (scope.platformAdmin) return true;
  if (propertyId === undefined || propertyId === null) return true;
  return scope.grants.some((g) => g.propertyId === null || g.propertyId === propertyId);
}

/**
 * Does this caller's scope cover the given location? Membership is modelled
 * at the property level (see module doc comment), so this resolves the
 * location's own property first, then defers to canAccessProperty.
 */
export async function canAccessLocation(
  supabase: Sb,
  scope: TenantScope,
  locationId: string | null | undefined,
): Promise<boolean> {
  if (scope.platformAdmin) return true;
  if (locationId === undefined || locationId === null) return true;
  const { data } = await supabase
    .from("restaurant_locations")
    .select("property_id")
    .eq("id", locationId)
    .maybeSingle();
  return canAccessProperty(scope, data?.property_id ?? null);
}

/**
 * General resource-scope check: covers whichever of propertyId/locationId
 * the resource actually carries. Prefer this at call sites that already
 * have a loaded row with one or both fields, instead of calling
 * canAccessProperty/canAccessLocation separately.
 */
export async function canAccessResource(
  supabase: Sb,
  scope: TenantScope,
  resource: ResourceScope,
): Promise<boolean> {
  if (scope.platformAdmin) return true;
  if (resource.propertyId !== undefined && resource.propertyId !== null) {
    if (!canAccessProperty(scope, resource.propertyId)) return false;
  }
  if (resource.locationId !== undefined && resource.locationId !== null) {
    if (!(await canAccessLocation(supabase, scope, resource.locationId))) return false;
  }
  return true;
}

/**
 * Location ids the caller may read/write, or `null` meaning "no restriction"
 * (platform admin, or holds at least one tenant-wide grant). A property-
 * scoped caller gets the concrete list of locations under their granted
 * properties — the caller applies `.in("location_id", ids)` itself. An
 * empty array (property-scoped but no matching locations) still means
 * zero rows, never "no restriction" — callers must not special-case it
 * away.
 *
 * For list/aggregate reads where the caller didn't name a specific
 * property/location (e.g. "show me mobile money health" with no
 * locationId): resolve once via getTenantScope, then use this instead of
 * fetching every tenant row and filtering client-side.
 */
export async function accessibleLocationIds(
  supabase: Sb,
  scope: TenantScope,
): Promise<string[] | null> {
  if (scope.platformAdmin) return null;
  if (scope.grants.some((g) => g.propertyId === null)) return null;
  const propertyIds = [
    ...new Set(scope.grants.map((g) => g.propertyId).filter((p): p is string => p !== null)),
  ];
  if (propertyIds.length === 0) return [];
  const { data } = await supabase
    .from("restaurant_locations")
    .select("id")
    .in("property_id", propertyIds);
  return (data ?? []).map((r: any) => r.id as string);
}

/** Never a valid row id — used to force a `.in(...)` filter to zero rows without special-casing an empty array per call site. */
export const NO_MATCH_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Resolves the property an aggregate/report-style read should actually run
 * against, for callers that accept an optional single propertyId (Decisions
 * Board, Staff Ask LexiBite context, and similar). A tenant-wide caller's
 * explicit request (or lack of one, meaning "everything") is honored as-is.
 * A property-scoped caller who names a property still has it validated
 * downstream (pass the result into assertTenantRead/assertCapability's
 * scope param); one who names nothing gets deterministically defaulted to
 * their first granted property — never silently aggregated across every
 * property they hold a grant on, and never left unscoped.
 */
export function resolveEffectivePropertyId(
  scope: TenantScope,
  requestedPropertyId: string | null | undefined,
): string | undefined {
  if (scope.platformAdmin || scope.grants.some((g) => g.propertyId === null)) {
    return requestedPropertyId ?? undefined;
  }
  if (requestedPropertyId) return requestedPropertyId;
  const propertyIds = [
    ...new Set(scope.grants.map((g) => g.propertyId).filter((p): p is string => p !== null)),
  ].sort();
  return propertyIds[0];
}

export async function assertTenantRead(
  supabase: Sb,
  userId: string,
  tenantId: string,
  scope?: ResourceScope,
) {
  if (await isPlatformAdmin(supabase, userId)) return;
  const grants = await memberGrantsInTenant(supabase, userId, tenantId);
  if (grants.length === 0)
    throw new Error("Forbidden — you do not belong to this restaurant tenant.");
  if (scope?.propertyId !== undefined && scope.propertyId !== null) {
    if (!grants.some((g) => grantCoversProperty(g, scope.propertyId))) {
      throw new Error("Forbidden — you do not have access to this property.");
    }
  }
  if (scope?.locationId !== undefined && scope.locationId !== null) {
    const { data } = await supabase
      .from("restaurant_locations")
      .select("property_id")
      .eq("id", scope.locationId)
      .maybeSingle();
    const locationProperty = data?.property_id ?? null;
    if (locationProperty && !grants.some((g) => grantCoversProperty(g, locationProperty))) {
      throw new Error("Forbidden — you do not have access to this location.");
    }
  }
}

/**
 * Capability + optional resource scope in one call. Omitting `scope` (every
 * existing call site) preserves the exact previous tenant-only behaviour.
 * Passing `scope.propertyId`/`scope.locationId` additionally requires the
 * caller to hold the capability's role at that specific property — a
 * tenant-wide grant for the role still passes; a grant scoped to a
 * *different* property does not.
 */
export async function assertCapability(
  supabase: Sb,
  userId: string,
  tenantId: string,
  capability: RestaurantCapability,
  scope?: ResourceScope,
) {
  if (await isPlatformAdmin(supabase, userId)) return;
  const grants = await memberGrantsInTenant(supabase, userId, tenantId);
  const allowed = rolesForCapability(capability) as readonly string[];
  const matching = grants.filter((g) => allowed.includes(g.role));
  if (matching.length === 0) {
    throw new Error(`Forbidden — "${capability}" requires one of: ${allowed.join(", ")}.`);
  }
  if (scope?.propertyId !== undefined && scope.propertyId !== null) {
    if (!matching.some((g) => grantCoversProperty(g, scope.propertyId))) {
      throw new Error(`Forbidden — "${capability}" is not granted to you at this property.`);
    }
  }
  if (scope?.locationId !== undefined && scope.locationId !== null) {
    const { data } = await supabase
      .from("restaurant_locations")
      .select("property_id")
      .eq("id", scope.locationId)
      .maybeSingle();
    const locationProperty = data?.property_id ?? null;
    if (locationProperty && !matching.some((g) => grantCoversProperty(g, locationProperty))) {
      throw new Error(`Forbidden — "${capability}" is not granted to you at this location.`);
    }
  }
}
