/**
 * Server-side guards for the Intelligence Core.
 * Server-only (filename is import-protected).
 *
 * Every decision here resolves through the canonical RBAC model
 * (`nova_has_permission` / `nova_user_roles_view`). There is no legacy role
 * lookup, no client-supplied role, and no bypass.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { assertPermission } from "@/lib/rbac/rbac.server";
import { INTEL_DECIDE_PERMISSION, INTEL_READ_PERMISSION } from "./permissions";

type Sb = any;

/** Canonical role codes held by the caller. */
export async function rolesFor(supabase: Sb, userId: string): Promise<string[]> {
  const { data } = await supabase
    .from("nova_user_roles_view")
    .select("role_code")
    .eq("user_id", userId);
  return (data ?? []).map((r: any) => String(r.role_code));
}

export async function assertIntelRead(supabase: Sb, userId: string) {
  await assertPermission(supabase, userId, INTEL_READ_PERMISSION);
}

export async function assertIntelDecide(supabase: Sb, userId: string) {
  await assertPermission(supabase, userId, INTEL_DECIDE_PERMISSION);
}

/** Narrow a query to modules the caller's roles may see. */
export async function visibleModules(supabase: Sb, userId: string): Promise<string[]> {
  const { allowedModulesForRoles } = await import("./permissions");
  return allowedModulesForRoles(await rolesFor(supabase, userId));
}
