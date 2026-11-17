import type { SupabaseClient } from "@supabase/supabase-js";

type Sb = SupabaseClient<any, any, any>;

export type PosStaffSession = {
  sessionId: string;
  staffUserId: string;
  role: string;
  propertyId: string | null;
};

export async function setPosPin(
  sb: Sb,
  userId: string,
  input: { tenantId: string; memberId: string; pin: string },
) {
  const { data, error } = await sb.rpc("restaurant_set_pos_pin", {
    p_tenant_id: input.tenantId,
    p_member_id: input.memberId,
    p_pin: input.pin,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function clearPosPin(
  sb: Sb,
  userId: string,
  input: { tenantId: string; memberId: string },
) {
  const { data, error } = await sb.rpc("restaurant_clear_pos_pin", {
    p_tenant_id: input.tenantId,
    p_member_id: input.memberId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function startPosSession(
  sb: Sb,
  userId: string,
  input: { tenantId: string; propertyId: string; pin: string; terminalId?: string },
): Promise<PosStaffSession> {
  const { data, error } = await sb.rpc("restaurant_start_pos_session_by_pin", {
    p_tenant_id: input.tenantId,
    p_property_id: input.propertyId,
    p_pin: input.pin,
    p_terminal_id: input.terminalId ?? "pos-web",
  });
  if (error) throw new Error(error.message);
  return data as PosStaffSession;
}

export async function endPosSession(
  sb: Sb,
  userId: string,
  sessionId: string,
) {
  const { data, error } = await sb.rpc("restaurant_end_pos_session", {
    p_session_id: sessionId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function resolvePosActor(
  sb: Sb,
  authenticatedUserId: string,
  sessionId: string | undefined,
  tenantId: string,
  propertyId?: string | null,
) {
  if (!sessionId) return authenticatedUserId;

  const { data: session, error } = await sb
    .from("restaurant_pos_sessions")
    .select("id, tenant_id, property_id, staff_user_id, active, expires_at")
    .eq("id", sessionId)
    .eq("tenant_id", tenantId)
    .eq("created_by", authenticatedUserId)
    .eq("active", true)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!session) throw new Error("POS staff session expired. Enter the staff PIN again.");
  if (propertyId && session.property_id && session.property_id !== propertyId) {
    throw new Error("POS staff session is scoped to another property.");
  }

  await sb
    .from("restaurant_pos_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", session.id)
    .eq("created_by", authenticatedUserId);

  return session.staff_user_id as string;
}
