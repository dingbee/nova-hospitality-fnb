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
  propertyId: z.string().uuid().nullable().optional(),
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

/**
 * Complete Embedded Signup v4 after the browser has received both the
 * authorization code and FINISH asset IDs. All Meta assets are revalidated
 * server-side before the token is stored by the encrypted integration vault.
 */
export async function completeMetaWhatsAppSignup(
  sb: Sb,
  userId: string,
  rawInput: CompleteMetaSignupInput,
  platform: MetaPlatformConfig = getPlatformConfig(),
) {
  const input = inputSchema.parse(rawInput);
  const propertyId = input.propertyId ?? null;

  await assertCapability(sb, userId, input.tenantId, "tenant.manage", { propertyId: propertyId ?? undefined });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", { propertyId });

  const exchanged = await exchangeEmbeddedSignupCode(input.authorizationCode, platform);
  const token = await inspectAccessToken(exchanged.accessToken, platform);
  assertRequiredWhatsAppPermissions(token);
  if (token.app_id !== platform.appId) throw new Error("Meta token belongs to a different application.");

  const expiresAt = typeof token.expires_at === "number" && token.expires_at > 0
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
  if (waba.id !== input.wabaId) throw new Error("The Meta WABA identity did not match the signup result.");

  const phones = await listWabaPhoneNumbers(credentials, platform);
  const phone = phones.find((candidate) => candidate.id === input.phoneNumberId);
  if (!phone) throw new Error("The selected phone number is not registered under this WABA.");

  await registerVerifiedPhoneNumber(credentials, input.registrationPin, platform);
  await subscribeWabaToApp(credentials, platform);
  const health = await checkPhoneNumberHealth(credentials, platform);

  const config = {
    wabaId: waba.id,
    phoneNumberId: phone.id,
    displayPhoneNumber: phone.display_phone_number ?? null,
    verifiedName: phone.verified_name ?? null,
    qualityRating: health.quality_rating ?? phone.quality_rating ?? null,
    graphApiVersion: platform.graphApiVersion ?? process.env.META_GRAPH_API_VERSION ?? "v27.0",
    metaAppId: platform.appId,
    tokenType: exchanged.tokenType,
    tokenExpiresAt: expiresAt?.toISOString() ?? null,
    grantedScopes: token.scopes ?? [],
    connectedAt: new Date().toISOString(),
  };

  let query = sb
    .from("api_integrations")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("provider", "meta-whatsapp")
    .eq("integration_type", "channel")
    .eq("channel_key", "whatsapp");
  query = propertyId ? query.eq("property_id", propertyId) : query.is("property_id", null);
  const { data: existing, error } = await query.maybeSingle();
  if (error) throw new Error("Unable to resolve the existing WhatsApp integration.");

  const integration = existing
    ? await updateIntegration(sb, userId, {
        tenantId: input.tenantId,
        integrationId: existing.id,
        propertyId,
        label: input.label,
        config,
        secret: exchanged.accessToken,
        status: "active",
      })
    : await registerIntegration(sb, userId, {
        tenantId: input.tenantId,
        propertyId,
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
  };
}
