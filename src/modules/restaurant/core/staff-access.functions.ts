import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuthForGateway } from "@/integrations/supabase/auth-middleware";

/**
 * Returns only the caller's access mode, authorised property choices, and
 * active PIN session. Operational data remains unavailable until a session
 * is active and is resolved by requireSupabaseAuth + RLS.
 */
export const getStaffAccessBootstrapFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuthForGateway])
  .handler(async ({ context }) => {
    const { data, error } = await (context.supabase as any).rpc(
      "restaurant_staff_access_bootstrap",
    );
    if (error) throw new Error("Unable to verify staff access. Refresh and try again.");
    return data as {
      platformAdmin: boolean;
      owner: boolean;
      hasRestaurantMembership: boolean;
      canActivate: boolean;
      tenantId: string | null;
      tenantName: string | null;
      pinConfigured: boolean;
      properties: Array<{ id: string; name: string; pinConfigured: boolean }>;
      activeSession: {
        sessionId: string;
        tenantId: string;
        propertyId: string;
        staffUserId: string;
        staffMemberId: string;
        role: string;
        terminalId: string;
        expiresAt: string;
      } | null;
    };
  });
