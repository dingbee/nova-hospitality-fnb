/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Commercial Administration is platform-level, not tenant-level (P01 spec).
 *
 * It deliberately does NOT reuse `isPlatformAdmin` from
 * `modules/restaurant/core/access.server.ts`: that helper calls
 * `has_any_role` with `_tenant_id = null`, and `has_any_role`'s tenant-scope
 * filter is vacuously true whenever the caller passes a null tenant id — in
 * practice this makes every tenant OWNER/GENERAL_MANAGER register as a
 * "platform admin". Reusing it here would let any restaurant owner reach
 * global commercial configuration (pricing, quotas, other tenants'
 * overrides), which is exactly what P01 prohibits.
 *
 * Instead, commercial admin status is a new, additive, tenant-independent
 * allow-list (`commercial_administrators`, migration 0034) with its own
 * SECURITY DEFINER check (`restaurant_is_commercial_admin`). Nothing else in
 * the codebase reads from it, so it carries none of the existing bypass's
 * risk. There is no self-service bootstrap path — the first commercial
 * admin is granted by direct SQL by a superuser.
 */
type Sb = any;

export class CommercialForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "Forbidden — commercial administration requires platform-level access.") {
    super(message);
    this.name = "CommercialForbiddenError";
  }
}

export async function isCommercialAdmin(sb: Sb, userId: string): Promise<boolean> {
  const { data, error } = await sb.rpc("restaurant_is_commercial_admin", { _user_id: userId });
  if (error) return false;
  return data === true;
}

export async function assertCommercialAdmin(sb: Sb, userId: string): Promise<void> {
  if (!(await isCommercialAdmin(sb, userId))) throw new CommercialForbiddenError();
}
