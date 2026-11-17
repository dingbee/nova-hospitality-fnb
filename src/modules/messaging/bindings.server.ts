/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase server rows are untyped at this boundary. */
import { z } from "zod";
import { writeCommercialAudit } from "@/modules/commercial/audit.server";
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { assertCapability } from "@/modules/restaurant/core/access.server";

type Sb = any;

const bindSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid(),
  locationId: z.string().uuid(),
  integrationId: z.string().uuid(),
  phoneNumberId: z.string().regex(/^\d{3,32}$/),
});

function getVerifiedPhoneAssets(config: Record<string, any>) {
  if (Array.isArray(config.phoneNumbers)) return config.phoneNumbers;
  if (typeof config.phoneNumberId === "string") {
    return [{
      id: config.phoneNumberId,
      displayPhoneNumber: config.displayPhoneNumber ?? null,
      verifiedName: config.verifiedName ?? null,
      qualityRating: config.qualityRating ?? null,
    }];
  }
  return [];
}

/** Bind a Meta-verified receiving number to one authorized customer-facing outlet. */
export async function bindMetaWhatsAppPhoneNumber(
  sb: Sb,
  userId: string,
  rawInput: z.infer<typeof bindSchema>,
) {
  const input = bindSchema.parse(rawInput);
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId,
  });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", {
    propertyId: input.propertyId,
  });

  const { data: integration, error: integrationError } = await sb
    .from("api_integrations")
    .select("id, tenant_id, property_id, provider, channel_key, integration_type, status, config")
    .eq("id", input.integrationId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("provider", "meta-whatsapp")
    .eq("channel_key", "whatsapp")
    .eq("integration_type", "channel")
    .maybeSingle();
  if (integrationError || !integration || integration.status !== "active") {
    throw new Error("An active WhatsApp Business integration for this property is required.");
  }

  const assets = getVerifiedPhoneAssets(integration.config ?? {});
  const phone = assets.find((asset: Record<string, any>) => asset.id === input.phoneNumberId);
  if (!phone || typeof integration.config?.wabaId !== "string") {
    throw new Error("The selected receiving number is not part of the server-verified Meta signup.");
  }

  const { data: location, error: locationError } = await sb
    .from("restaurant_locations")
    .select("id, tenant_id, property_id, location_type, is_storage, status")
    .eq("id", input.locationId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (
    locationError ||
    !location ||
    location.status !== "active" ||
    location.is_storage ||
    !["outlet", "restaurant", "bar"].includes(location.location_type)
  ) {
    throw new Error("The selected location is not an active customer-facing outlet in this property.");
  }

  const { data: existing, error: existingError } = await sb
    .from("wa_phone_number_bindings")
    .select("id, tenant_id, property_id, location_id, integration_id")
    .eq("phone_number_id", input.phoneNumberId)
    .maybeSingle();
  if (existingError) throw new Error("Unable to resolve the receiving-number binding.");

  if (existing) {
    if (
      existing.tenant_id !== input.tenantId ||
      existing.property_id !== input.propertyId ||
      existing.location_id !== input.locationId ||
      existing.integration_id !== input.integrationId
    ) {
      throw new Error("This WhatsApp receiving number is already assigned to another outlet or property.");
    }
    const { error } = await sb
      .from("wa_phone_number_bindings")
      .update({ status: "active" })
      .eq("id", existing.id)
      .eq("tenant_id", input.tenantId)
      .eq("property_id", input.propertyId);
    if (error) throw new Error("Unable to reactivate the WhatsApp receiving-number binding.");
    await writeCommercialAudit(sb, {
      actorId: userId,
      action: "whatsapp.phone_binding.reactivated",
      entityType: "wa_phone_number_binding",
      entityId: existing.id,
      tenantId: input.tenantId,
      after: { propertyId: input.propertyId, locationId: input.locationId, phoneNumberId: input.phoneNumberId },
    });
    return { id: existing.id, phoneNumberId: input.phoneNumberId, locationId: input.locationId };
  }

  const { data: created, error: createError } = await sb
    .from("wa_phone_number_bindings")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId,
      location_id: input.locationId,
      integration_id: input.integrationId,
      waba_id: integration.config.wabaId,
      phone_number_id: input.phoneNumberId,
      display_phone_number: phone.displayPhoneNumber ?? null,
      verified_name: phone.verifiedName ?? null,
      quality_rating: phone.qualityRating ?? null,
      status: "active",
      created_by: userId,
    })
    .select("id")
    .single();
  if (createError || !created) {
    if (createError?.code === "23505") {
      throw new Error("This WhatsApp receiving number has already been assigned.");
    }
    throw new Error("Unable to create the WhatsApp receiving-number binding.");
  }

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "whatsapp.phone_binding.created",
    entityType: "wa_phone_number_binding",
    entityId: created.id,
    tenantId: input.tenantId,
    after: {
      propertyId: input.propertyId,
      locationId: input.locationId,
      integrationId: input.integrationId,
      phoneNumberId: input.phoneNumberId,
    },
  });

  return {
    id: created.id,
    phoneNumberId: input.phoneNumberId,
    locationId: input.locationId,
    displayPhoneNumber: phone.displayPhoneNumber ?? null,
  };
}

export async function listMetaWhatsAppPhoneBindings(
  sb: Sb,
  userId: string,
  input: { tenantId: string; propertyId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId,
  });
  const { data, error } = await sb
    .from("wa_phone_number_bindings")
    .select("id, location_id, integration_id, waba_id, phone_number_id, display_phone_number, verified_name, quality_rating, status, created_at")
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Unable to list WhatsApp receiving-number bindings.");
  return data ?? [];
}

export async function disableMetaWhatsAppIntegration(
  sb: Sb,
  userId: string,
  input: { tenantId: string; propertyId: string; integrationId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId,
  });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", {
    propertyId: input.propertyId,
  });

  const { data: integration, error: lookupError } = await sb
    .from("api_integrations")
    .select("id, provider, channel_key, status")
    .eq("id", input.integrationId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (lookupError || !integration || integration.provider !== "meta-whatsapp" || integration.channel_key !== "whatsapp") {
    throw new Error("WhatsApp integration not found in this tenant/property scope.");
  }

  const { error: integrationError } = await sb
    .from("api_integrations")
    .update({ status: "disabled" })
    .eq("id", input.integrationId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId);
  if (integrationError) throw new Error("Unable to disable the WhatsApp integration.");

  const { error: bindingError } = await sb
    .from("wa_phone_number_bindings")
    .update({ status: "disabled" })
    .eq("integration_id", input.integrationId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId);
  if (bindingError) throw new Error("WhatsApp integration disabled, but receiving-number bindings need reconciliation.");

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "whatsapp.integration.disabled",
    entityType: "api_integration",
    entityId: input.integrationId,
    tenantId: input.tenantId,
    after: { propertyId: input.propertyId, status: "disabled" },
  });
  return { integrationId: input.integrationId, status: "disabled" as const };
}
