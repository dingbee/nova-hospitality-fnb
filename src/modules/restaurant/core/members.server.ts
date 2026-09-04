/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Tenant membership administration (server-only).
 *
 * RLS restricts writes to tenant owners/general managers and platform
 * admins; these guards fail fast with a readable error before the round trip.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "./access.server";
import type { removeMemberSchema, upsertMemberSchema, listMembersSchema } from "./contracts";

type Sb = any;

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
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const propertyId = input.propertyId ?? null;
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
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { error } = await sb
    .from("restaurant_members")
    .delete()
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);
  return { ok: true };
}
