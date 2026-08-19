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

export async function listMembers(sb: Sb, userId: string, input: z.infer<typeof listMembersSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_members")
    .select("id, user_id, role, property_id, created_at")
    .eq("tenant_id", input.tenantId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as any[];
}

export async function upsertMember(sb: Sb, userId: string, input: z.infer<typeof upsertMemberSchema>) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { data, error } = await sb
    .from("restaurant_members")
    .insert({ tenant_id: input.tenantId, user_id: input.userId, role: input.role })
    .select("id, user_id, role")
    .single();
  if (error) {
    if (/duplicate key/i.test(error.message)) throw new Error("That person already holds this role here.");
    throw new Error(error.message);
  }
  return data;
}

export async function removeMember(sb: Sb, userId: string, input: z.infer<typeof removeMemberSchema>) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { error } = await sb
    .from("restaurant_members")
    .delete()
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);
  return { ok: true };
}
