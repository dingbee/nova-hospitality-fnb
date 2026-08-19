/**
 * First-run provisioning endpoint logic (PRODUCTIZATION-3, Phase 6).
 *
 * The gateway is the only caller of nova_local.bootstrap_property(); the
 * function itself is service_role-only and idempotent, so this layer is
 * responsible for validation and password hashing, not for authorisation
 * shortcuts.
 */
import type { SQL } from "bun";
import {
  bootstrapFingerprint,
  bootstrapRequestSchema,
  tenantSlugFrom,
  type BootstrapResponse,
} from "../../src/modules/runtime/local/bootstrap-contract";
import { assertPasswordPolicy, hashPassword } from "../../src/modules/runtime/local/password.server";
import { AuthError } from "./auth";

export async function bootstrapProperty(
  sql: SQL,
  payload: unknown,
): Promise<BootstrapResponse> {
  const parsed = bootstrapRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AuthError(parsed.error.issues.map((i) => i.message).join("; "), 400);
  }
  const request = parsed.data;

  try {
    assertPasswordPolicy(request.administrator.password);
  } catch (error) {
    throw new AuthError((error as Error).message, 400);
  }

  const slug = tenantSlugFrom(request.property.name);
  if (!slug) throw new AuthError("Property name must contain letters or numbers", 400);

  const passwordHash = await hashPassword(request.administrator.password);

  try {
    const [row] = await sql`
      SELECT nova_local.bootstrap_property(
        ${bootstrapFingerprint(request)},
        ${slug},
        ${request.property.legalName ?? request.property.name},
        ${request.property.name},
        ${request.property.country.toUpperCase()},
        ${request.property.currency.toUpperCase()},
        ${request.property.timezone},
        ${request.outlet.name},
        ${request.outlet.type},
        ${request.administrator.name},
        ${request.administrator.email},
        ${passwordHash}
      ) AS result`;

    const result = row?.result as Record<string, string>;
    return {
      status: result["status"] === "already_bootstrapped" ? "already_bootstrapped" : "bootstrapped",
      tenantId: result["tenant_id"]!,
      propertyId: result["property_id"],
      locationId: result["location_id"],
      adminUserId: result["admin_user_id"]!,
    };
  } catch (error) {
    const message = (error as Error).message ?? "";
    // The database refuses a second bootstrap; surface that as a refusal, not
    // as an internal error, and never as a partial success.
    if (/already has an administrator|already exists/.test(message)) {
      return { status: "refused", reason: "This installation has already been set up." };
    }
    throw error;
  }
}