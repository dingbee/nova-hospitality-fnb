/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Workspace resolution: which tenant, properties and outlets the caller may use.
 */
import type { RestaurantWorkspace } from "./contracts";
import { getTenantScope, isPlatformAdmin, rolesInTenant } from "./access.server";
import { DEMO_TENANT_ID, DEMO_PROPERTY_ID, DEMO_LOCATION_ID } from "@/modules/lexibite-demo/constants";

type Sb = any;

export async function getWorkspace(
  supabase: Sb,
  userId: string,
  input: { tenantId?: string } = {},
): Promise<RestaurantWorkspace> {
  const platformAdmin = await isPlatformAdmin(supabase, userId);

  // Start with the caller's RLS-scoped tenant list.
  const { data: tenantRows, error } = await supabase
    .from("restaurant_tenants")
    .select("id, slug, name, status, settings")
    .order("name");
  if (error) throw new Error(error.message);

  let tenants = (tenantRows ?? []) as any[];

  // Recovery for the existing canonical demo only: some deployed RLS states
  // hide the tenant row from the authenticated list even though the signed-in
  // account is a verified platform administrator. Do not broaden discovery to
  // every tenant and do not mutate data; perform a server-only, ID-pinned read.
  if (platformAdmin && tenants.length === 0) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: demoTenant, error: demoTenantError } = await supabaseAdmin
      .from("restaurant_tenants")
      .select("id, slug, name, status, settings")
      .eq("id", DEMO_TENANT_ID)
      .maybeSingle();
    if (demoTenantError) throw new Error(demoTenantError.message);
    if (demoTenant) {
      tenants = [{
        ...demoTenant,
        // The canonical demo identity is stable; never surface UAT fixture
        // labels if the same canonical row has been relabelled accidentally.
        name: "LexiBite Demo Restaurant",
      }];
    }
  }

  const active = tenants.find((t) => t.id === input.tenantId) ?? tenants[0] ?? null;

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
  // never be offered a property/location they hold no grant for.
  const tenantWide = scope.platformAdmin || scope.grants.some((g) => g.propertyId === null);
  const allProperties = (properties ?? []) as any[];
  const allLocations = (locations ?? []) as any[];

  // Keep the GTM demo bound to its canonical property/outlet. This prevents
  // UAT fixture properties under the same tenant ID from replacing or
  // contaminating the working demo workspace; no database rows are changed.
  const demoProperties = active.id === DEMO_TENANT_ID
    ? allProperties.filter((p) => p.id === DEMO_PROPERTY_ID)
    : allProperties;
  const demoLocations = active.id === DEMO_TENANT_ID
    ? allLocations.filter((l) => l.id === DEMO_LOCATION_ID)
    : allLocations;

  const scopedProperties = tenantWide
    ? demoProperties
    : demoProperties.filter((p) => scope.grants.some((g) => g.propertyId === p.id));
  const accessiblePropertyIds = new Set(scopedProperties.map((p) => p.id));
  const scopedLocations = tenantWide
    ? demoLocations
    : demoLocations.filter((l) => accessiblePropertyIds.has(l.property_id));

  return {
    tenant: {
      id: active.id,
      slug: active.slug,
      name: active.id === DEMO_TENANT_ID ? "LexiBite Demo Restaurant" : active.name,
      status: active.status,
      settings: active.settings ?? {},
    },
    tenants: tenants.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.id === DEMO_TENANT_ID ? "LexiBite Demo Restaurant" : t.name,
    })),
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
