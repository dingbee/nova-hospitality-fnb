/**
 * NOVA Hospitality F&B — staff directory, backed by the RBAC model.
 *
 * Reads require STAFF:READ; role grants require ADMINISTRATION:ADMIN. Both are
 * checked server-side before any row is touched, and again by RLS in SQL.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPermission } from "@/lib/rbac/rbac.server";
import { ROLES, ROLE_LABELS, type Role } from "@/lib/rbac/permissions";
import { logActivity } from "@/lib/activity-log.server";

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

export const assignRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; role: string; tenantId?: string | null; propertyId?: string | null; outletId?: string | null }) =>
    z
      .object({
        userId: z.string().uuid(),
        role: z.enum(ROLES),
        tenantId: z.string().uuid().nullable().optional(),
        propertyId: z.string().uuid().nullable().optional(),
        outletId: z.string().uuid().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "ADMINISTRATION:ADMIN");
    const { error } = await supabase.from("rbac_user_roles").insert({
      user_id: data.userId,
      role_code: data.role,
      tenant_id: data.tenantId ?? null,
      property_id: data.propertyId ?? null,
      outlet_id: data.outletId ?? null,
      granted_by: userId,
    });
    if (error && !error.message.includes("duplicate")) throw new Error(error.message);
    await logActivity(supabase, {
      actorId: userId,
      action: "rbac.role.assign",
      entityType: "rbac_user_roles",
      entityId: data.userId,
      metadata: { role: data.role },
    });
    return { ok: true };
  });

export const revokeRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; role: string }) =>
    z.object({ userId: z.string().uuid(), role: z.enum(ROLES) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertPermission(supabase, userId, "ADMINISTRATION:ADMIN");
    const { error } = await supabase
      .from("rbac_user_roles")
      .delete()
      .eq("user_id", data.userId)
      .eq("role_code", data.role);
    if (error) throw new Error(error.message);
    await logActivity(supabase, {
      actorId: userId,
      action: "rbac.role.revoke",
      entityType: "rbac_user_roles",
      entityId: data.userId,
      metadata: { role: data.role },
    });
    return { ok: true };
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
