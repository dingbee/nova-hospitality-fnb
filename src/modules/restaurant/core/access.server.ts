/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Server-side tenant guards. Server-only (filename is import-protected).
 *
 * RLS is the enforcement point; these guards fail fast with readable errors and
 * stop a caller from even attempting a cross-tenant write.
 */
import type { RestaurantRole } from "./contracts";
import { rolesForCapability, type RestaurantCapability } from "./permissions";

type Sb = any;

export async function isPlatformAdmin(supabase: Sb, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_any_role", {
    _user_id: userId,
    _roles: ["owner", "admin", "manager"],
  });
  if (error) return false;
  return Boolean(data);
}

export async function rolesInTenant(
  supabase: Sb,
  userId: string,
  tenantId: string,
): Promise<RestaurantRole[]> {
  const { data } = await supabase
    .from("restaurant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);
  return (data ?? []).map((r: any) => r.role as RestaurantRole);
}

export async function assertTenantRead(supabase: Sb, userId: string, tenantId: string) {
  if (await isPlatformAdmin(supabase, userId)) return;
  const roles = await rolesInTenant(supabase, userId, tenantId);
  if (roles.length === 0) throw new Error("Forbidden — you do not belong to this restaurant tenant.");
}

export async function assertCapability(
  supabase: Sb,
  userId: string,
  tenantId: string,
  capability: RestaurantCapability,
) {
  if (await isPlatformAdmin(supabase, userId)) return;
  const roles = await rolesInTenant(supabase, userId, tenantId);
  const allowed = rolesForCapability(capability) as readonly string[];
  if (!roles.some((r) => allowed.includes(r))) {
    throw new Error(`Forbidden — "${capability}" requires one of: ${allowed.join(", ")}.`);
  }
}