/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Tenant membership administration (server-only).
 *
 * RLS restricts writes to tenant owners/general managers and platform
 * admins; these guards fail fast with a readable error before the round trip.
 *
 * Property scope on the *membership being written* — not just the caller's
 * own — must be checked explicitly here: `assertCapability`'s optional
 * `scope` param treats an omitted/null propertyId as "nothing to check"
 * (correct for a resource that simply has no property field), but a
 * `restaurant_members` row with `property_id: null` means "tenant-wide
 * grant" — a real, broader privilege. Without `assertCanManageMembership`, a
 * property-scoped owner/general_manager could grant or revoke tenant-wide
 * access, or reach a sibling property's membership, despite never holding
 * that scope themselves.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead, getTenantScope } from "./access.server";
import { rolesForCapability } from "./permissions";
import type {
  removeMemberSchema,
  upsertMemberSchema,
  updateMemberRoleSchema,
  listMembersSchema,
} from "./contracts";

type Sb = any;

/**
 * Authorizes writing a `restaurant_members` row whose own scope is
 * `targetPropertyId` (null = tenant-wide). A property-scoped grant may only
 * reach a property it already covers; only a caller holding a tenant-wide
 * owner/general_manager grant (or platform admin) may create, change, or
 * remove a tenant-wide membership.
 */
async function assertCanManageMembership(
  sb: Sb,
  userId: string,
  tenantId: string,
  targetPropertyId: string | null,
) {
  if (targetPropertyId !== null) {
    await assertCapability(sb, userId, tenantId, "tenant.manage", {
      propertyId: targetPropertyId,
    });
    return;
  }
  const scope = await getTenantScope(sb, userId, tenantId);
  if (scope.platformAdmin) return;
  const allowed = rolesForCapability("tenant.manage") as readonly string[];
  const hasTenantWideGrant = scope.grants.some(
    (g) => g.propertyId === null && allowed.includes(g.role),
  );
  if (!hasTenantWideGrant) {
    throw new Error(
      'Forbidden — granting or revoking tenant-wide access requires a tenant-wide "owner" or "general_manager" grant.',
    );
  }
}

export async function listMembers(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listMembersSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_members")
    .select("id, user_id, role, property_id, created_at")
    .eq("tenant_id", input.tenantId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as any[];
}

export async function upsertMember(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertMemberSchema>,
) {
  const propertyId = input.propertyId ?? null;
  await assertCanManageMembership(sb, userId, input.tenantId, propertyId);
  if (propertyId) {
    // A property id must actually belong to this tenant — otherwise a typo
    // or a forged id would silently scope a member to nothing (or, worse,
    // a hierarchy-inconsistent property from a different tenant).
    const { data: property } = await sb
      .from("restaurant_properties")
      .select("id")
      .eq("id", propertyId)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    if (!property) throw new Error("That property does not belong to this tenant.");
  }
  const { data, error } = await sb
    .from("restaurant_members")
    .insert({
      tenant_id: input.tenantId,
      user_id: input.userId,
      role: input.role,
      property_id: propertyId,
    })
    .select("id, user_id, role, property_id")
    .single();
  if (error) {
    if (/duplicate key/i.test(error.message)) {
      throw new Error(
        propertyId
          ? "That person already holds this role at this property."
          : "That person already holds this role tenant-wide.",
      );
    }
    throw new Error(error.message);
  }
  return data;
}

export async function removeMember(
  sb: Sb,
  userId: string,
  input: z.infer<typeof removeMemberSchema>,
) {
  const { data: existing, error: fetchError } = await sb
    .from("restaurant_members")
    .select("id, property_id")
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!existing) return { ok: true };
  await assertCanManageMembership(sb, userId, input.tenantId, existing.property_id ?? null);
  const { error } = await sb
    .from("restaurant_members")
    .delete()
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

/**
 * Changes an existing member's role and/or property scope by updating their
 * specific row in place, rather than inserting an additional grant. The
 * caller must be authorized for both the membership's current scope (they
 * are revoking/altering it) and its new scope (they are granting it) —
 * changing FROM a property they don't control, or TO one they don't
 * control (including "every property"), is exactly the escalation
 * `assertCanManageMembership` exists to block.
 */
export async function updateMemberRole(
  sb: Sb,
  userId: string,
  input: z.infer<typeof updateMemberRoleSchema>,
) {
  const { data: existing, error: fetchError } = await sb
    .from("restaurant_members")
    .select("id, property_id")
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new Error("That membership no longer exists.");

  const newPropertyId = input.propertyId ?? null;
  await assertCanManageMembership(sb, userId, input.tenantId, existing.property_id ?? null);
  await assertCanManageMembership(sb, userId, input.tenantId, newPropertyId);

  if (newPropertyId) {
    const { data: property } = await sb
      .from("restaurant_properties")
      .select("id")
      .eq("id", newPropertyId)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    if (!property) throw new Error("That property does not belong to this tenant.");
  }

  const { data, error } = await sb
    .from("restaurant_members")
    .update({ role: input.role, property_id: newPropertyId })
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId)
    .select("id, user_id, role, property_id")
    .single();
  if (error) {
    if (/duplicate key/i.test(error.message)) {
      throw new Error(
        newPropertyId
          ? "That person already holds this role at this property."
          : "That person already holds this role tenant-wide.",
      );
    }
    throw new Error(error.message);
  }
  return data;
}
