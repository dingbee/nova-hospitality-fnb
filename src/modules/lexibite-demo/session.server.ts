/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * LexiBite Demo Access — session activation (P02.3/P02.4).
 *
 * Called only from an already-authenticated request (requireSupabaseAuth
 * has already verified the caller's Supabase JWT). Reaching this function
 * at all is the verification proof: the caller only has a valid session
 * because they possessed a Supabase-issued, single-use action link sent to
 * their claimed email address. Nothing here trusts a client-supplied
 * tenant, property, location or role — every one of those is a hardcoded
 * literal inside restaurant_grant_demo_session() (migration 0082), and this
 * function only ever calls that RPC through the caller's own authenticated
 * client so auth.uid() resolves to them, never through the service-role
 * client (whose JWT carries no user id at all, which the function's own
 * "no authenticated caller" check would reject).
 */
import { DEMO_REGISTRATION_STATUS } from "./constants";

type Sb = any;

export class DemoAccessError extends Error {
  readonly status = 403;
}

export interface DemoSessionResult {
  sessionId: string;
  tenantId: string;
  propertyId: string;
  locationId: string;
  role: string;
  expiresAt: string;
  launchUrl: string;
  selfOrderUrl: string | null;
}

export async function activateDemoSession(
  sb: Sb,
  admin: Sb,
  userId: string,
): Promise<DemoSessionResult> {
  const { data: reg } = await admin
    .from("lexibite_demo_registrations")
    .select("id, status")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (!reg) {
    throw new DemoAccessError("No demo registration is associated with this account.");
  }

  if (reg.status === DEMO_REGISTRATION_STATUS.PENDING_VERIFICATION) {
    await admin
      .from("lexibite_demo_registrations")
      .update({ status: DEMO_REGISTRATION_STATUS.VERIFIED, verified_at: new Date().toISOString() })
      .eq("id", reg.id);
  }

  const { data, error } = await sb.rpc("restaurant_grant_demo_session");
  if (error) throw new DemoAccessError(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        out_session_id: string;
        out_tenant_id: string;
        out_property_id: string;
        out_location_id: string;
        out_role: string;
        out_expires_at: string;
      }
    | undefined;
  if (!row) throw new DemoAccessError("Could not start a demo session.");

  const { data: table } = await admin
    .from("restaurant_tables")
    .select("id")
    .eq("tenant_id", row.out_tenant_id)
    .eq("status", "available")
    .limit(1)
    .maybeSingle();

  return {
    sessionId: row.out_session_id,
    tenantId: row.out_tenant_id,
    propertyId: row.out_property_id,
    locationId: row.out_location_id,
    role: row.out_role,
    expiresAt: row.out_expires_at,
    launchUrl: "/",
    selfOrderUrl: table?.id ? `/order/${table.id}` : null,
  };
}

export async function getMyDemoSession(
  admin: Sb,
  userId: string,
): Promise<DemoSessionResult | null> {
  const { data } = await admin
    .from("lexibite_demo_sessions")
    .select("id, tenant_id, property_id, location_id, role, status, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  // Real-time expiry, not just the stored status: nothing flips 'active' to
  // 'expired' automatically (that column update only ever happens as a side
  // effect of an admin running resetDemoEnvironment), so a session past its
  // expires_at is already denied by RLS (restaurant_member_active, migration
  // 0083) but would otherwise still read back as "active" here.
  if (!data || data.status !== "active" || new Date(data.expires_at) <= new Date()) return null;
  return {
    sessionId: data.id,
    tenantId: data.tenant_id,
    propertyId: data.property_id,
    locationId: data.location_id,
    role: data.role,
    expiresAt: data.expires_at,
    launchUrl: "/",
    selfOrderUrl: null,
  };
}
