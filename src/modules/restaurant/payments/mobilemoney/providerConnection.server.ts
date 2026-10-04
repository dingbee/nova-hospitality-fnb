/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Secure outlet-level provider connection management.
 *
 * Provider credentials are reversible because an adapter must call the PSP
 * with the real credential. They are encrypted at rest with the existing
 * AES-256-GCM primitive and never included in an account read response.
 */
import { assertCapability } from "@/modules/restaurant/core/access.server";
import { resolvePublicOrigin } from "@/modules/restaurant/core/product";
import { getRequestHeader } from "@tanstack/react-start/server";
import { decryptSecret, encryptSecret } from "@/modules/api-platform/crypto.server";
import {
  getMobileMoneyProvider,
  mobileMoneyProviderCodeSchema,
  type MobileMoneyProviderCode,
} from "./providerRegistry";

type Sb = any;

export interface MobileMoneyProviderCredentials {
  apiKey?: string;
  apiSecret?: string;
  webhookSecret?: string;
  [key: string]: string | undefined;
}

export interface MobileMoneyProviderConfig {
  baseUrl?: string;
  merchantId?: string;
  accountId?: string;
  callbackUrl?: string;
  [key: string]: string | undefined;
}

const SAFE_ACCOUNT_COLUMNS =
  "id, tenant_id, property_id, location_id, mode, network, merchant_number, provider_code, environment, activation_state, provider_config, provider_status, last_health_check_at, last_provider_error, created_at, updated_at";

function validateCredentials(
  providerCode: MobileMoneyProviderCode,
  credentials: MobileMoneyProviderCredentials,
) {
  const provider = getMobileMoneyProvider(providerCode);
  if (!provider) throw new Error("Unsupported Mobile Money provider.");

  for (const field of provider.credentialFields) {
    if (!credentials[field]?.trim()) {
      throw new Error(provider.name + " requires " + field + ".");
    }
  }
}

export async function configureMobileMoneyProvider(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    locationId: string;
    providerCode: string;
    config?: MobileMoneyProviderConfig;
    credentials: MobileMoneyProviderCredentials;
  },
) {
  await assertCapability(sb, userId, input.tenantId, "mobile_money.manage", {
    locationId: input.locationId,
  });

  const providerCode = mobileMoneyProviderCodeSchema.parse(input.providerCode);
  validateCredentials(providerCode, input.credentials);

  const configured = { ...(input.config ?? {}) };
  if (providerCode === "payin" && !configured.callbackUrl) {
    try {
      const origin = resolvePublicOrigin(
        getRequestHeader("host"),
        getRequestHeader("x-forwarded-proto") ?? "https",
      );
      configured.callbackUrl = `${origin}/api/mobile-money-webhook/${providerCode}`;
    } catch {
      // A missing request host must not prevent credential storage; the
      // connector remains configured but will not receive push callbacks until
      // a callback URL is supplied or the connection is configured again.
    }
  }

  const encrypted = encryptSecret(JSON.stringify(input.credentials));
  const { data, error } = await sb
    .from("restaurant_mobile_money_accounts")
    .update({
      provider_code: providerCode,
      provider_config: configured,
      credential_ciphertext: encrypted.ciphertext,
      credential_iv: encrypted.iv,
      credential_tag: encrypted.tag,
      provider_status: "configured",
      last_provider_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", input.tenantId)
    .eq("location_id", input.locationId)
    .select(SAFE_ACCOUNT_COLUMNS)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Mobile Money account is not configured for this outlet.");

  return { ...data, credentialsConfigured: true };
}

/** Server-only. Never call this from a UI/server-function response. */
export async function getMobileMoneyProviderCredentials(
  supabaseAdmin: Sb,
  tenantId: string,
  locationId: string,
): Promise<{
  providerCode: MobileMoneyProviderCode;
  config: MobileMoneyProviderConfig;
  credentials: MobileMoneyProviderCredentials;
} | null> {
  const { data } = await supabaseAdmin
    .from("restaurant_mobile_money_accounts")
    .select(
      "provider_code, provider_config, credential_ciphertext, credential_iv, credential_tag",
    )
    .eq("tenant_id", tenantId)
    .eq("location_id", locationId)
    .maybeSingle();

  if (!data?.credential_ciphertext) return null;

  const providerCode = mobileMoneyProviderCodeSchema.safeParse(data.provider_code);
  if (!providerCode.success) return null;

  const plaintext = decryptSecret({
    ciphertext: data.credential_ciphertext,
    iv: data.credential_iv,
    tag: data.credential_tag,
  });

  let credentials: MobileMoneyProviderCredentials;
  try {
    credentials = JSON.parse(plaintext);
  } catch {
    throw new Error("Stored Mobile Money provider credentials are invalid.");
  }

  return {
    providerCode: providerCode.data,
    config: (data.provider_config ?? {}) as MobileMoneyProviderConfig,
    credentials,
  };
}

export async function clearMobileMoneyProvider(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "mobile_money.manage", {
    locationId: input.locationId,
  });

  const { data, error } = await sb
    .from("restaurant_mobile_money_accounts")
    .update({
      provider_code: "test",
      provider_config: {},
      credential_ciphertext: null,
      credential_iv: null,
      credential_tag: null,
      provider_status: "not_configured",
      last_health_check_at: null,
      last_provider_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", input.tenantId)
    .eq("location_id", input.locationId)
    .select(SAFE_ACCOUNT_COLUMNS)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Mobile Money account is not configured for this outlet.");
  return data;
}
