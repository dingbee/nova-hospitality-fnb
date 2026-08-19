/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Workspace resolution: which tenant, properties and outlets the caller may use.
 */
import type { RestaurantWorkspace } from "./contracts";
import { isPlatformAdmin, rolesInTenant } from "./access.server";

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

  const tenants = (tenantRows ?? []) as any[];
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

  const [{ data: properties }, { data: locations }, { data: subscription }, roles] = await Promise.all([
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
  ]);

  return {
    tenant: {
      id: active.id,
      slug: active.slug,
      name: active.name,
      status: active.status,
      settings: active.settings ?? {},
    },
    tenants: tenants.map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
    properties: (properties ?? []) as any,
    locations: (locations ?? []) as any,
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