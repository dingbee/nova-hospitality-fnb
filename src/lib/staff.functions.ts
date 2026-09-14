/**
 * NOVA Hospitality F&B — staff directory, backed by the RBAC model.
 *
 * Reads require STAFF:READ; role grants require ADMINISTRATION:ADMIN. Both are
 * checked server-side before any row is touched, and again by RLS in SQL.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPermission, ForbiddenError } from "@/lib/rbac/rbac.server";
import { ROLES, ROLE_LABELS, roleHasPermission, type Permission, type Role } from "@/lib/rbac/permissions";
import { logActivity } from "@/lib/activity-log.server";

/**
 * Authorizes granting/revoking a role at a specific (tenant, property,
 * outlet) target scope — the same both-sides discipline
 * `assertCanManageMembership` applies to `restaurant_members`. Unlike
 * `assertPermission`'s `ScopeRef`, a `null` at any level of `target` here
 * is a real, broader privilege (tenant-wide, property-wide, or fully
 * platform-wide), never "nothing to check": passing `assertPermission`
 * with an omitted scope always short-circuits to true for a NULL grant
 * level, which would let a caller whose own grant is scoped (e.g. OWNER at
 * one property) write a broader (e.g. tenant-wide) grant for someone else.
 * A caller may only reach a target level that is NULL if their own grant
 * is ALSO NULL at that level.
 */
async function assertCanManageRbacRole(
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client is untyped at this seam. */
  supabase: any,
  callerId: string,
  perm: Permission,
  target: { tenantId: string | null; propertyId: string | null; outletId: string | null },
): Promise<void> {
  const { data, error } = await supabase
    .from("rbac_user_roles")
    .select("role_code, tenant_id, property_id, outlet_id")
    .eq("user_id", callerId);
  if (error) throw new Error(error.message);
  const grants = (data ?? []) as {
    role_code: string;
    tenant_id: string | null;
    property_id: string | null;
    outlet_id: string | null;
  }[];
  const covers = (level: "tenant_id" | "property_id" | "outlet_id", targetVal: string | null) =>
    (g: (typeof grants)[number]) =>
      targetVal === null ? g[level] === null : g[level] === null || g[level] === targetVal;
  const authorized = grants.some(
    (g) =>
      roleHasPermission(g.role_code as Role, perm) &&
      covers("tenant_id", target.tenantId)(g) &&
      covers("property_id", target.propertyId)(g) &&
      covers("outlet_id", target.outletId)(g),
  );
  if (!authorized) throw new ForbiddenError(perm);
}

export const APP_ROLES = ROLES;
export type AppRole = Role;
export { ROLE_LABELS };

export type StaffUser = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  status: "pending" | "active" | "disabled";
  created_at: string | null;
  roles: AppRole[];
};

/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this seam. */
export const listStaffUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<StaffUser[]> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "STAFF:READ");

    const { data: users, error } = await supabase
      .from("app_users")
      .select("user_id, email, full_name, status, created_at")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    const { data: roles, error: roleError } = await supabase
      .from("nova_user_roles_view")
      .select("user_id, role_code");
    if (roleError) throw new Error(roleError.message);

    const byUser = new Map<string, AppRole[]>();
    for (const r of roles ?? []) {
      const list = byUser.get(r.user_id) ?? [];
      list.push(r.role_code as AppRole);
      byUser.set(r.user_id, list);
    }
    return (users ?? []).map((u: any) => ({ ...u, roles: byUser.get(u.user_id) ?? [] }));
  });

/**
 * Provisions a brand-new person: no existing account, no `app_users` row —
 * the gap `listStaffUsers`'s dropdown-only selection left, since every
 * other flow here (assignRole, TeamPanel's tenant role grant) assumes a
 * user already exists to pick from. Creates the `auth.users` account via
 * the service-role admin API (the only way to do this — there is no public
 * self-signup route in this app) and mirrors it into `app_users` so the
 * person appears in the staff directory immediately, `status: "pending"`
 * until they actually sign in.
 *
 * Email delivery depends on SMTP being configured for this Supabase
 * project (Authentication → Emails in the dashboard). Without it the
 * account is still created — inviteUserByEmail always succeeds at that —
 * but no invite email is sent, so an admin needs another way to get the
 * person a sign-in link (e.g. Supabase's dashboard "reset password" action
 * for that user, or the "magic link" flow) until SMTP is set up.
 *
 * Pulled out of the createServerFn handler so it's callable directly
 * against a fake service-role client in tests, matching how the rest of
 * this codebase separates DB logic from the createServerFn wiring around it.
 */
export async function provisionInvitedStaffUser(
  adminClient: any,
  input: { email: string; fullName?: string },
): Promise<{ userId: string; email: string }> {
  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
    input.email,
    input.fullName ? { data: { full_name: input.fullName } } : undefined,
  );
  if (inviteError) {
    // A person invited twice is a normal operator mistake, not a bug —
    // surface it as one rather than a raw Supabase auth error.
    if (/already been registered|already exists/i.test(inviteError.message)) {
      throw new Error(`${input.email} already has an account.`);
    }
    throw new Error(inviteError.message);
  }
  const newUserId = invited.user.id as string;

  const { error: profileError } = await adminClient.from("app_users").insert({
    user_id: newUserId,
    email: input.email,
    full_name: input.fullName ?? null,
    status: "pending",
  });
  if (profileError) throw new Error(profileError.message);

  return { userId: newUserId, email: input.email };
}

export const inviteStaffUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { email: string; fullName?: string }) =>
    z
      .object({
        email: z.string().email(),
        fullName: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "STAFF:ADMIN");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const result = await provisionInvitedStaffUser(supabaseAdmin, data);

    await logActivity(supabase, {
      actorId: userId,
      action: "staff.user.invited",
      entityType: "app_users",
      entityId: result.userId,
      metadata: { email: data.email },
    });
    return result;
  });

export type RbacRoleTarget = {
  userId: string;
  role: Role;
  tenantId?: string | null;
  propertyId?: string | null;
  outletId?: string | null;
};

const rbacRoleTargetSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(ROLES),
  tenantId: z.string().uuid().nullable().optional(),
  propertyId: z.string().uuid().nullable().optional(),
  outletId: z.string().uuid().nullable().optional(),
});

/**
 * Core grant logic, pulled out of the createServerFn handler so it's
 * callable directly against a fake client in tests — same reason
 * `provisionInvitedStaffUser` is separated from `inviteStaffUser` above.
 */
export async function grantRbacRole(
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client is untyped at this seam. */
  supabase: any,
  callerId: string,
  input: RbacRoleTarget,
): Promise<{ ok: true }> {
  const target = {
    tenantId: input.tenantId ?? null,
    propertyId: input.propertyId ?? null,
    outletId: input.outletId ?? null,
  };
  await assertCanManageRbacRole(supabase, callerId, "ADMINISTRATION:ADMIN", target);
  const { error } = await supabase.from("rbac_user_roles").insert({
    user_id: input.userId,
    role_code: input.role,
    tenant_id: target.tenantId,
    property_id: target.propertyId,
    outlet_id: target.outletId,
    granted_by: callerId,
  });
  if (error && !error.message.includes("duplicate")) throw new Error(error.message);
  await logActivity(supabase, {
    actorId: callerId,
    action: "rbac.role.assign",
    entityType: "rbac_user_roles",
    entityId: input.userId,
    metadata: { role: input.role },
  });
  return { ok: true };
}

/**
 * Core revoke logic — deletes exactly the one grant row at this scope, not
 * every row matching (user, role) regardless of scope, which would revoke a
 * sibling property's grant as collateral damage for the same role.
 */
export async function revokeRbacRole(
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client is untyped at this seam. */
  supabase: any,
  callerId: string,
  input: RbacRoleTarget,
): Promise<{ ok: true }> {
  const target = {
    tenantId: input.tenantId ?? null,
    propertyId: input.propertyId ?? null,
    outletId: input.outletId ?? null,
  };
  await assertCanManageRbacRole(supabase, callerId, "ADMINISTRATION:ADMIN", target);
  let query = supabase.from("rbac_user_roles").delete().eq("user_id", input.userId).eq("role_code", input.role);
  query = target.tenantId === null ? query.is("tenant_id", null) : query.eq("tenant_id", target.tenantId);
  query =
    target.propertyId === null ? query.is("property_id", null) : query.eq("property_id", target.propertyId);
  query = target.outletId === null ? query.is("outlet_id", null) : query.eq("outlet_id", target.outletId);
  const { error } = await query;
  if (error) throw new Error(error.message);
  await logActivity(supabase, {
    actorId: callerId,
    action: "rbac.role.revoke",
    entityType: "rbac_user_roles",
    entityId: input.userId,
    metadata: { role: input.role },
  });
  return { ok: true };
}

export const assignRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: RbacRoleTarget) => rbacRoleTargetSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    return grantRbacRole(supabase, userId, data);
  });

export const revokeRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: RbacRoleTarget) => rbacRoleTargetSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    return revokeRbacRole(supabase, userId, data);
  });

export const setStaffUserDisabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; disabled: boolean }) =>
    z.object({ userId: z.string().uuid(), disabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "STAFF:ADMIN");
    const { error } = await supabase
      .from("app_users")
      .update({ status: data.disabled ? "disabled" : "active" })
      .eq("user_id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
/* eslint-enable @typescript-eslint/no-explicit-any */
