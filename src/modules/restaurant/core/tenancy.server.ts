/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Workspace resolution: which tenant, properties and outlets the caller may use.
 */
import type { RestaurantWorkspace } from "./contracts";
import { getTenantScope, isPlatformAdmin, rolesInTenant } from "./access.server";

type Sb = any;

export async function getWorkspace(
  supabase: Sb,
  userId: string,
  input: { tenantId?: string; propertyId?: string; locationId?: string } = {},
): Promise<RestaurantWorkspace> {
  const platformAdmin = await isPlatformAdmin(supabase, userId);

  // RLS already narrows this to tenants the caller may read.
  const { data: tenantRows, error } = await supabase
    .from("restaurant_tenants")
    .select("id, slug, name, status, settings")
    .order("name");
  if (error) throw new Error(error.message);

  const tenants = (tenantRows ?? []) as any[];
  const active = tenants.find((t) => t.id === input.tenantId) ?? tenants[0] ?? null;

  if (!active) {
    return {
      tenant: null,
      tenants: [],
      properties: [],
      locations: [],
      activePropertyId: null,
      activeLocationId: null,
      subscription: null,
      roles: [],
      platformAdmin,
    };
  }

  const [{ data: properties }, { data: locations }, { data: subscription }, roles, scope] =
    await Promise.all([
      supabase
        .from("restaurant_properties")
        .select("id, tenant_id, slug, name, timezone, currency, status")
        .eq("tenant_id", active.id)
        .order("name"),
      supabase
        .from("restaurant_locations")
        .select("id, tenant_id, property_id, slug, name, location_type, status")
        .eq("tenant_id", active.id)
        .order("name"),
      supabase
        .from("restaurant_subscriptions")
        .select("plan, status, seats, features, trial_ends_at, current_period_end")
        .eq("tenant_id", active.id)
        .maybeSingle(),
      rolesInTenant(supabase, userId, active.id),
      getTenantScope(supabase, userId, active.id),
    ]);

  // Every property/location selector in the app is built from this list —
  // a property-scoped member (not tenant-wide, not platform admin) must
  // never be offered a property/location they hold no grant for, even in a
  // dropdown (spec: "hiding a property from a dropdown is not sufficient"
  // cuts the other way too — an *unfiltered* dropdown is a live leak).
  const tenantWide = scope.platformAdmin || scope.grants.some((g) => g.propertyId === null);
  const allProperties = (properties ?? []) as any[];
  const allLocations = (locations ?? []) as any[];
  const scopedProperties = tenantWide
    ? allProperties
    : allProperties.filter((p) => scope.grants.some((g) => g.propertyId === p.id));
  const accessiblePropertyIds = new Set(scopedProperties.map((p) => p.id));
  const scopedLocations = tenantWide
    ? allLocations
    : allLocations.filter((l) => accessiblePropertyIds.has(l.property_id));

  // Resolve the operating context only after the caller's accessible scope is
  // known. Client-supplied context is a selector, never an authorization
  // grant. A forged property/outlet id therefore fails closed.
  const requestedProperty = input.propertyId
    ? scopedProperties.find((p) => p.id === input.propertyId) ?? null
    : null;
  if (input.propertyId && !requestedProperty) {
    throw new Error("Forbidden — that property is outside your restaurant access scope.");
  }

  const activePropertyId =
    requestedProperty?.id ??
    (scopedProperties.length === 1 ? scopedProperties[0]?.id ?? null : null);

  const requestedLocation = input.locationId
    ? scopedLocations.find((l) => l.id === input.locationId) ?? null
    : null;
  if (input.locationId && !requestedLocation) {
    throw new Error("Forbidden — that outlet is outside your restaurant access scope.");
  }
  if (requestedLocation && activePropertyId && requestedLocation.property_id !== activePropertyId) {
    throw new Error("That outlet does not belong to the selected property.");
  }

  const activeLocationId =
    requestedLocation?.id ??
    (activePropertyId
      ? scopedLocations.find((l) => l.property_id === activePropertyId)?.id ?? null
      : null);

  return {
    tenant: {
      id: active.id,
      slug: active.slug,
      name: active.name,
      status: active.status,
      settings: active.settings ?? {},
    },
    tenants: tenants.map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
    properties: scopedProperties as any,
    locations: scopedLocations as any,
    activePropertyId,
    activeLocationId,
    subscription: (subscription ?? null) as any,
    roles,
    platformAdmin,
  };
}

/** Feature gate hook for future plan-based commercialisation. */
export function planAllows(
  workspace: RestaurantWorkspace,
  feature: string,
  fallback = true,
): boolean {
  const features = workspace.subscription?.features ?? {};
  return feature in features ? Boolean(features[feature]) : fallback;
}
