import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";

type Sb = any;

const profileScopeSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
});

const saveProfileSchema = profileScopeSchema.extend({
  name: z.string().trim().min(2).max(120),
  costClass: z.enum(["service_consumable", "other_direct_variable"]),
  inventoryItemId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  quantityPerCover: z.number().positive().max(100000),
});

export async function listOperationalConsumptionProfiles(
  sb: Sb,
  userId: string,
  raw: unknown,
) {
  const input = profileScopeSchema.parse(raw);
  await assertTenantRead(sb, userId, input.tenantId);
  const { data: profiles, error: profileError } = await sb
    .from("restaurant_consumption_profiles")
    .select("id, name, cost_class, property_id, location_id, active, effective_from, effective_to")
    .eq("tenant_id", input.tenantId)
    .eq("active", true)
    .order("name");
  if (profileError) throw new Error(profileError.message);
  const scopedProfiles = ((profiles ?? []) as any[]).filter((p) =>
    (!input.propertyId || p.property_id === null || p.property_id === input.propertyId) &&
    (!input.locationId || p.location_id === null || p.location_id === input.locationId)
  );
  const profileIds = scopedProfiles.map((p) => p.id);
  if (profileIds.length === 0) return [];
  const { data: rules, error: ruleError } = await sb
    .from("restaurant_consumption_rules")
    .select("id, profile_id, inventory_item_id, unit_id, quantity_per_cover, active, effective_from, effective_to")
    .eq("tenant_id", input.tenantId)
    .in("profile_id", profileIds)
    .order("created_at");
  if (ruleError) throw new Error(ruleError.message);
  const byProfile = new Map<string, any[]>();
  for (const rule of (rules ?? []) as any[]) {
    const rows = byProfile.get(rule.profile_id) ?? [];
    rows.push(rule);
    byProfile.set(rule.profile_id, rows);
  }
  return scopedProfiles.map((profile) => ({ ...profile, rules: byProfile.get(profile.id) ?? [] }));
}

export async function saveOperationalConsumptionProfile(
  sb: Sb,
  userId: string,
  raw: unknown,
) {
  const input = saveProfileSchema.parse(raw);
  await assertCapability(sb, userId, input.tenantId, "inventory.manage", {
    propertyId: input.propertyId,
    locationId: input.locationId,
  });
  if (!input.propertyId) throw new Error("Select a property before configuring operational consumables.");
  if (input.locationId) {
    const { data: location, error } = await sb
      .from("restaurant_locations")
      .select("id, property_id")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.locationId)
      .single();
    if (error || !location || location.property_id !== input.propertyId) {
      throw new Error("The selected outlet does not belong to this property.");
    }
  }
  const [{ data: property, error: propertyError }, { data: item, error: itemError }] = await Promise.all([
    sb.from("restaurant_properties").select("id, currency").eq("tenant_id", input.tenantId).eq("id", input.propertyId).single(),
    sb.from("restaurant_inventory_items").select("id, property_id, unit_id, currency").eq("tenant_id", input.tenantId).eq("id", input.inventoryItemId).single(),
  ]);
  if (propertyError || !property) throw new Error("The selected property could not be verified.");
  if (itemError || !item || item.property_id !== input.propertyId) {
    throw new Error("The inventory item must belong to the selected property.");
  }
  if (!/^[A-Z]{3}$/.test(String(property.currency ?? "")) ||
      !/^[A-Z]{3}$/.test(String(item.currency ?? "")) ||
      item.currency !== property.currency) {
    throw new Error("The inventory item currency must match the property's configured currency.");
  }
  const effectiveFrom = new Date().toISOString().slice(0, 10);
  let existingProfileQuery = sb
    .from("restaurant_consumption_profiles")
    .select("id, effective_from, cost_class")
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("name", input.name);
  existingProfileQuery = input.locationId
    ? existingProfileQuery.eq("location_id", input.locationId)
    : existingProfileQuery.is("location_id", null);
  const { data: existing, error: existingError } = await existingProfileQuery.maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing?.cost_class && existing.cost_class !== input.costClass) {
    throw new Error("Use a new profile name when changing a consumable cost classification so historical costing remains traceable.");
  }
  const profilePayload = {
    tenant_id: input.tenantId,
    property_id: input.propertyId,
    location_id: input.locationId ?? null,
    name: input.name,
    cost_class: input.costClass,
    active: true,
    effective_from: existing?.effective_from ?? effectiveFrom,
    effective_to: null,
  };
  const profileQuery = existing?.id
    ? sb.from("restaurant_consumption_profiles").update(profilePayload).eq("tenant_id", input.tenantId).eq("id", existing.id)
    : sb.from("restaurant_consumption_profiles").insert(profilePayload);
  const { data: profile, error: saveProfileError } = await profileQuery.select("id, name, cost_class, property_id, location_id").single();
  if (saveProfileError || !profile) throw new Error(saveProfileError?.message ?? "The consumable profile could not be saved.");
  const { data: rule, error: ruleError } = await sb
    .from("restaurant_consumption_rules")
    .upsert({
      tenant_id: input.tenantId,
      profile_id: profile.id,
      inventory_item_id: item.id,
      unit_id: input.unitId ?? item.unit_id ?? null,
      quantity_per_cover: input.quantityPerCover,
      active: true,
      effective_from: effectiveFrom,
      effective_to: null,
    }, { onConflict: "profile_id,inventory_item_id" })
    .select("id, profile_id, inventory_item_id, unit_id, quantity_per_cover")
    .single();
  if (ruleError || !rule) throw new Error(ruleError?.message ?? "The consumable rule could not be saved.");
  return { ...profile, rule };
}
