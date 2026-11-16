/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import { registerIntegration, updateIntegration } from "@/modules/api-platform/integrations.server";
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { assertCapability } from "@/modules/restaurant/core/access.server";
import {
  assertRequiredWhatsAppPermissions,
  checkPhoneNumberHealth,
  exchangeEmbeddedSignupCode,
  getWabaDetails,
  inspectAccessToken,
  listWabaPhoneNumbers,
  registerVerifiedPhoneNumber,
  subscribeWabaToApp,
  type MetaPlatformConfig,
} from "./meta-cloud-api.server";

type Sb = any;

const inputSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid(),
  authorizationCode: z.string().min(1).max(4096),
  wabaId: z.string().regex(/^\d{3,32}$/),
  phoneNumberId: z.string().regex(/^\d{3,32}$/),
  registrationPin: z.string().regex(/^\d{6}$/),
  label: z.string().min(2).max(120).default("WhatsApp Business"),
});

export type CompleteMetaSignupInput = z.infer<typeof inputSchema>;

function getPlatformConfig(): MetaPlatformConfig {
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error("Meta application credentials are not configured server-side.");
  }
  return { appId, appSecret, graphApiVersion: process.env.META_GRAPH_API_VERSION };
}

function normalisePhoneAssets(config: Record<string, any>): Array<Record<string, unknown>> {
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

/**
 * Complete Embedded Signup v4 after the browser has received both the
 * authorization code and FINISH asset IDs. One WABA is bound per property;
 * multiple verified phone numbers under that WABA are retained in the same
 * encrypted api_integrations credential record.
 */
export async function completeMetaWhatsAppSignup(
  sb: Sb,
  userId: string,
  rawInput: CompleteMetaSignupInput,
  platform: MetaPlatformConfig = getPlatformConfig(),
) {
  const input = inputSchema.parse(rawInput);

  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId,
  });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", {
    propertyId: input.propertyId,
  });

  const exchanged = await exchangeEmbeddedSignupCode(input.authorizationCode, platform);
  const token = await inspectAccessToken(exchanged.accessToken, platform);
  assertRequiredWhatsAppPermissions(token);
  if (token.app_id !== platform.appId) {
    throw new Error("Meta token belongs to a different application.");
  }

  const expiresAt =
    typeof token.expires_at === "number" && token.expires_at > 0
      ? new Date(token.expires_at * 1000)
      : null;
  if (expiresAt && expiresAt.getTime() <= Date.now() + 300_000) {
    throw new Error("Meta access token expires too soon to complete onboarding.");
  }

  const credentials = {
    accessToken: exchanged.accessToken,
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
  };
  const waba = await getWabaDetails(credentials, platform);
  if (waba.id !== input.wabaId) {
    throw new Error("The Meta WABA identity did not match the signup result.");
  }

  const query = sb
    .from("api_integrations")
    .select("id, config")
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("provider", "meta-whatsapp")
    .eq("integration_type", "channel")
    .eq("channel_key", "whatsapp");
  const { data: existing, error } = await query.maybeSingle();
  if (error) throw new Error("Unable to resolve the existing WhatsApp integration.");

  const existingConfig =
    existing?.config && typeof existing.config === "object" ? existing.config : {};
  if (existing && existingConfig.wabaId !== waba.id) {
    throw new Error("This property already has a different WhatsApp Business Account connected.");
  }

  const phones = await listWabaPhoneNumbers(credentials, platform);
  const phone = phones.find((candidate) => candidate.id === input.phoneNumberId);
  if (!phone) {
    throw new Error("The selected phone number is not registered under this WABA.");
  }

  await registerVerifiedPhoneNumber(credentials, input.registrationPin, platform);
  await subscribeWabaToApp(credentials, platform);
  const health = await checkPhoneNumberHealth(credentials, platform);

  const phoneAssets = normalisePhoneAssets(existingConfig).filter(
    (candidate) => candidate.id !== phone.id,
  );
  phoneAssets.push({
    id: phone.id,
    displayPhoneNumber: phone.display_phone_number ?? null,
    verifiedName: phone.verified_name ?? null,
    qualityRating: health.quality_rating ?? phone.quality_rating ?? null,
  });

  const primaryPhoneNumberId =
    typeof existingConfig.primaryPhoneNumberId === "string" &&
    phoneAssets.some((candidate) => candidate.id === existingConfig.primaryPhoneNumberId)
      ? existingConfig.primaryPhoneNumberId
      : phone.id;
  const primaryPhone = phoneAssets.find((candidate) => candidate.id === primaryPhoneNumberId);

  const config = {
    wabaId: waba.id,
    phoneNumberId: primaryPhoneNumberId,
    primaryPhoneNumberId,
    phoneNumbers: phoneAssets,
    displayPhoneNumber: primaryPhone?.displayPhoneNumber ?? null,
    verifiedName: primaryPhone?.verifiedName ?? null,
    qualityRating: primaryPhone?.qualityRating ?? null,
    graphApiVersion:
      platform.graphApiVersion ?? process.env.META_GRAPH_API_VERSION ?? "v27.0",
    metaAppId: platform.appId,
    tokenType: exchanged.tokenType,
    tokenExpiresAt: expiresAt?.toISOString() ?? null,
    grantedScopes: token.scopes ?? [],
    connectedAt: existingConfig.connectedAt ?? new Date().toISOString(),
    lastReauthorizedAt: new Date().toISOString(),
  };

  const integration = existing
    ? await updateIntegration(sb, userId, {
        tenantId: input.tenantId,
        integrationId: existing.id,
        propertyId: input.propertyId,
        label: input.label,
        config,
        secret: exchanged.accessToken,
        status: "active",
      })
    : await registerIntegration(sb, userId, {
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        provider: "meta-whatsapp",
        channelKey: "whatsapp",
        integrationType: "channel",
        label: input.label,
        config,
        secret: exchanged.accessToken,
      });

  return {
    integrationId: integration.id,
    provider: "meta-whatsapp" as const,
    channelKey: "whatsapp" as const,
    wabaId: waba.id,
    phoneNumberId: phone.id,
    displayPhoneNumber: phone.display_phone_number ?? null,
    verifiedName: phone.verified_name ?? null,
    tokenExpiresAt: expiresAt?.toISOString() ?? null,
    connectedPhoneNumbers: phoneAssets.length,
  };
}
