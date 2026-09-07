/**
 * Caller-facing RBAC reads. These are intentionally the ONLY RBAC surface the
 * browser talks to; they never accept a role or permission from the client.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { listPermissions } from "./rbac.server";
import type { Permission } from "./permissions";

export interface CurrentPrincipal {
  userId: string;
  email: string | null;
  roles: string[];
  permissions: Permission[];
  tenantId: string | null;
  /**
   * P01: platform-level Commercial Administration access — deliberately NOT
   * derived from `permissions`/ROLE_PERMISSIONS (every OWNER role holds
   * ALL_PERMISSIONS across every domain, including any new domain added
   * here, which would immediately leak commercial control to every tenant
   * owner). Backed by the separate, additive `commercial_administrators`
   * allow-list instead — see modules/commercial/access.server.ts.
   */
  commercialAdmin: boolean;
}

export const getCurrentPrincipal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CurrentPrincipal> => {
    const { supabase, userId, claims } = context as {
      supabase: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      userId: string;
      claims: Record<string, unknown>;
    };
    const { data: roleRows, error } = await supabase
      .from("nova_user_roles_view")
      .select("role_code, tenant_id")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    const permissions = await listPermissions(supabase, userId);
    const { isCommercialAdmin } = await import("@/modules/commercial/access.server");
    const commercialAdmin = await isCommercialAdmin(supabase, userId);
    return {
      userId,
      email: (claims["email"] as string) ?? null,
      roles: (roleRows ?? []).map((r: { role_code: string }) => r.role_code),
      permissions,
      tenantId: (roleRows ?? [])[0]?.tenant_id ?? null,
      commercialAdmin,
    };
  });
