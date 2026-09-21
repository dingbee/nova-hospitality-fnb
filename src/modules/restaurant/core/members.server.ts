/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Tenant membership administration (server-only).
 *
 * RLS restricts writes to tenant owners/general managers and platform
 * admins; these guards fail fast with a readable error before the round trip.
 */
import type { z } from "zod";
import { assertCanManageMembership, assertTenantRead } from "./access.server";
import type { removeMemberSchema, upsertMemberSchema, listMembersSchema } from "./contracts";
import { logActivity } from "@/lib/activity-log.server";

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
  await assertCanManageMembership(sb, input.tenantId, propertyId);
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
  await logActivity(sb, {
    actorId: userId,
    tenantId: input.tenantId,
    action: "restaurant.member.granted",
    entityType: "restaurant_members",
    entityId: data.id,
    metadata: { userId: input.userId, role: input.role, propertyId },
  });
  return data;
}

export async function removeMember(
  sb: Sb,
  userId: string,
  input: z.infer<typeof removeMemberSchema>,
) {
  const { data: target, error: findError } = await sb
    .from("restaurant_members")
    .select("user_id, role, property_id")
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (findError) throw new Error(findError.message);
  if (!target) throw new Error("That member was not found in this tenant.");
  await assertCanManageMembership(sb, input.tenantId, target.property_id ?? null);
  const { error } = await sb
    .from("restaurant_members")
    .delete()
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);
  await logActivity(sb, {
    actorId: userId,
    tenantId: input.tenantId,
    action: "restaurant.member.revoked",
    entityType: "restaurant_members",
    entityId: input.memberId,
    metadata: { userId: target.user_id, role: target.role, propertyId: target.property_id ?? null },
  });
  return { ok: true };
}


export async function listMemberStationAssignments(
  sb: Sb,
  userId: string,
  input: z.infer<typeof import("./contracts").listMemberStationAssignmentsSchema>,
) {
  const { data: member, error: memberError } = await sb
    .from("restaurant_members")
    .select("id, user_id, role, property_id")
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (memberError) throw new Error(memberError.message);
  if (!member) throw new Error("That member was not found in this tenant.");

  await assertTenantRead(sb, userId, input.tenantId, {
    propertyId: member.property_id,
  });

  const { data, error } = await sb
    .from("restaurant_member_station_assignments")
    .select("id, station_id, active, created_at, updated_at")
    .eq("member_id", input.memberId)
    .eq("active", true);
  if (error) throw new Error(error.message);

  let stationQuery = sb
    .from("restaurant_stations")
    .select("id, code, name, station_type, production_area, parent_station_id, property_id, location_id, active, sort_order")
    .eq("tenant_id", input.tenantId)
    .eq("active", true)
    .order("sort_order")
    .order("name");
  if (member.property_id) stationQuery = stationQuery.eq("property_id", member.property_id);
  const { data: stations, error: stationError } = await stationQuery;
  if (stationError) throw new Error(stationError.message);

  return {
    member: {
      id: member.id,
      userId: member.user_id,
      role: member.role,
      propertyId: member.property_id,
    },
    assignments: (data ?? []) as any[],
    stations: (stations ?? []) as any[],
  };
}

export async function setMemberStationAssignment(
  sb: Sb,
  userId: string,
  input: z.infer<typeof import("./contracts").setMemberStationAssignmentSchema>,
) {
  const { data: member, error: memberError } = await sb
    .from("restaurant_members")
    .select("id, user_id, role, property_id")
    .eq("id", input.memberId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (memberError) throw new Error(memberError.message);
  if (!member) throw new Error("That member was not found in this tenant.");

  await assertCanManageMembership(sb, input.tenantId, member.property_id ?? null);

  const { data: station, error: stationError } = await sb
    .from("restaurant_stations")
    .select("id, tenant_id, property_id, location_id, active")
    .eq("id", input.stationId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (stationError) throw new Error(stationError.message);
  if (!station) throw new Error("That station was not found in this tenant.");
  if (member.property_id && station.property_id !== member.property_id) {
    throw new Error("That station is outside the staff member's property scope.");
  }

  const { data: existing } = await sb
    .from("restaurant_member_station_assignments")
    .select("id")
    .eq("member_id", input.memberId)
    .eq("station_id", input.stationId)
    .maybeSingle();

  if (existing) {
    const { data, error } = await sb
      .from("restaurant_member_station_assignments")
      .update({ active: input.active, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("id, member_id, station_id, active")
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  if (!input.active) return { id: null, member_id: input.memberId, station_id: input.stationId, active: false };

  const { data, error } = await sb
    .from("restaurant_member_station_assignments")
    .insert({
      member_id: input.memberId,
      station_id: input.stationId,
      active: true,
    })
    .select("id, member_id, station_id, active")
    .single();
  if (error) throw new Error(error.message);
  return data;
}
