/**
 * NOVA Hospitality F&B — server-side RBAC enforcement.
 *
 * Every privileged server function composes `requirePermission(...)`. The
 * check runs in SQL (`public.nova_has_permission`) against the caller's own
 * token, so a client that calls the RPC endpoint directly — bypassing the UI
 * entirely — is refused by the same rule that hides the button.
 */
import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Permission } from "./permissions";

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(permission: Permission) {
    super(`Forbidden: missing permission ${permission}`);
    this.name = "ForbiddenError";
  }
}

export interface ScopeRef {
  tenantId?: string | null;
  propertyId?: string | null;
  outletId?: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase client is untyped at this seam. */
export async function hasPermission(
  supabase: any,
  userId: string,
  perm: Permission,
  scope: ScopeRef = {},
): Promise<boolean> {
  const { data, error } = await supabase.rpc("nova_has_permission", {
    _user_id: userId,
    _permission: perm,
    _tenant_id: scope.tenantId ?? null,
    _property_id: scope.propertyId ?? null,
    _outlet_id: scope.outletId ?? null,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function assertPermission(
  supabase: any,
  userId: string,
  perm: Permission,
  scope: ScopeRef = {},
): Promise<void> {
  if (!(await hasPermission(supabase, userId, perm, scope))) throw new ForbiddenError(perm);
}

/**
 * Guard for rbac_user_roles writes (grant/revoke a platform-tier role on
 * another user). Delegates to the database's own
 * nova_can_manage_scoped(permission, tenant, property, outlet) — the exact
 * predicate migration 0059_p09_tenancy_write_isolation.sql put behind the
 * "rbac_user_roles_admin_scoped" RLS policy — rather than assertPermission's
 * unscoped nova_has_permission check: passing no scope treats a NULL grant
 * level as "don't check this level" for the *caller's own* grant too, so a
 * caller holding ADMINISTRATION:ADMIN in one tenant passes the same check
 * as a platform-wide grant and can request a write for an unrelated tenant.
 * RLS already refuses that write (fail-closed) — this makes the refusal a
 * clean, pre-round-trip error instead of a raw database one.
 */
export async function assertCanManageRbacRole(
  supabase: any,
  scope: ScopeRef,
): Promise<void> {
  const { data, error } = await supabase.rpc("nova_can_manage_scoped", {
    _permission: "ADMINISTRATION:ADMIN",
    _tenant_id: scope.tenantId ?? null,
    _property_id: scope.propertyId ?? null,
    _outlet_id: scope.outletId ?? null,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new ForbiddenError("ADMINISTRATION:ADMIN" as Permission);
}

export async function listPermissions(supabase: any, userId: string): Promise<Permission[]> {
  const { data, error } = await supabase.rpc("nova_permissions_for", { _user_id: userId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { permission: string }[]).map((r) => r.permission as Permission);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Middleware factory. Usage:
 *
 *   createServerFn({ method: "POST" })
 *     .middleware([requirePermission("INVENTORY:WRITE")])
 *     .handler(async ({ context }) => { ... })
 *
 * The authenticated Supabase client, userId and claims stay on `context`,
 * so downstream handlers are unchanged from the pre-extraction code.
 */
export function requirePermission(perm: Permission) {
  return createMiddleware({ type: "function" })
    .middleware([requireSupabaseAuth])
    .server(async ({ next, context }) => {
      const ctx = context as { supabase: unknown; userId: string };
      await assertPermission(ctx.supabase, ctx.userId, perm);
      return next({ context: { permission: perm } });
    });
}
