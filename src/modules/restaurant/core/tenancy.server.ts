/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Workspace resolution: which tenant, properties and outlets the caller may use.
 */
import type { RestaurantWorkspace } from "./contracts";
import { getTenantScope, isPlatformAdmin, rolesInTenant } from "./access.server";

// The populated, production GTM demo workspace. Do not confuse it with the legacy
// Kilimanjaro fixture used by the separate public demo-registration flow.
const GTM_WORKSPACE_TENANT_ID = "9f7c1d4e-6b0a-4c8d-9a31-1b2c3d4e5f60";

type Sb = any;

export async function getWorkspace(
  supabase: Sb,
  userId: string,
  input: { tenantId?: string } = {},
): Promise<RestaurantWorkspace> {
  const platformAdmin = await isPlatformAdmin(supabase, userId);

  // RLS already narrows this to tenants the caller may read.
  const { data: tenantRows, error } = await supabase
    .from("restaurant_tenants")
    .select("id, slug, name, status, settings")
    .order("name");
  if (error) throw new Error(error.message);

  let tenants = (tenantRows ?? []) as any[];

  // A workspace row can be hidden by a deployed RLS state even when its owner
  // membership is readable. Recover only this known GTM tenant, and only after
  // verifying the signed-in user has its tenant-wide owner grant. The elevated
  // client is used for this single read only; no data is changed.
  if (!tenants.some((t) => t.id === GTM_WORKSPACE_TENANT_ID)) {
    const { data: grants, error: grantsError } = await supabase
      .from("restaurant_members")
      .select("role, property_id")
      .eq("tenant_id", GTM_WORKSPACE_TENANT_ID)
      .eq("user_id", userId);

    const ownsWorkspace = !grantsError
      && (grants ?? []).some((g: any) => g.role === "owner" && g.property_id === null);

    if (ownsWorkspace) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: gtmTenant, error: gtmTenantError } = await supabaseAdmin
        .from("restaurant_tenants")
        .select("id, slug, name, status, settings")
        .eq("id", GTM_WORKSPACE_TENANT_ID)
        .maybeSingle();
      if (gtmTenantError) throw new Error(gtmTenantError.message);
      if (gtmTenant) tenants = [...tenants, gtmTenant];
    }
  }

  const active = tenants.find((t) => t.id === input.tenantId)
    ?? tenants.find((t) => t.id === GTM_WORKSPACE_TENANT_ID)
    ?? tenants[0]
    ?? null;

  if (!active) {
    return {
      tenant: null,
      tenants: [],
      properties: [],
      locations: [],
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
