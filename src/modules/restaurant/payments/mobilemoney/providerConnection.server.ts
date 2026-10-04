/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Secure Mobile Money provider connection management.
 *
 * Provider credentials are tenant-owned. Outlet accounts remain the
 * operational payment context, but provider secrets live once at tenant
 * level and are encrypted at rest.
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
import type { MobileMoneyEnvironment, MobileMoneyNetwork } from "./contracts";

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

export interface MobileMoneyTenantProviderConnection {
  providerCode: MobileMoneyProviderCode;
  environment: MobileMoneyEnvironment;
  enabledNetworks: MobileMoneyNetwork[];
  config: MobileMoneyProviderConfig;
  credentialsConfigured: boolean;
  providerStatus: string;
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

function normalizeNetworks(value: unknown): MobileMoneyNetwork[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<MobileMoneyNetwork>(["mpesa", "mixx_yas", "airtel_money", "halopesa", "ttcl_pesa"]);
  return [...new Set(value.filter((n): n is MobileMoneyNetwork => typeof n === "string" && allowed.has(n as MobileMoneyNetwork)))];
}

/**
 * Tenant-level control-plane read. Secrets are never returned.
 */
export async function getMobileMoneyTenantProviderConnection(
  sb: Sb,
  userId: string,
  input: { tenantId: string },
): Promise<MobileMoneyTenantProviderConnection | null> {
  await assertCapability(sb, userId, input.tenantId, "mobile_money.manage");

  const { data } = await sb
    .from("restaurant_mobile_money_provider_connections")
    .select("provider_code, environment, enabled_networks, provider_config, provider_status, credential_ciphertext")
    .eq("tenant_id", input.tenantId)
    .maybeSingle();

  if (!data) return null;

  const providerCode = mobileMoneyProviderCodeSchema.safeParse(data.provider_code);
  if (!providerCode.success) return null;

  return {
    providerCode: providerCode.data,
    environment: data.environment as MobileMoneyEnvironment,
    enabledNetworks: normalizeNetworks(data.enabled_networks),
    config: (data.provider_config ?? {}) as MobileMoneyProviderConfig,
    credentialsConfigured: Boolean(data.credential_ciphertext),
    providerStatus: String(data.provider_status ?? "not_configured"),
  };
}

/**
 * Tenant-level provider configuration. This is the authoritative place for
 * provider selection, environment, enabled networks and encrypted credentials.
 */
export async function configureMobileMoneyTenantProvider(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    providerCode: string;
    environment: MobileMoneyEnvironment;
    enabledNetworks: MobileMoneyNetwork[];
    config?: MobileMoneyProviderConfig;
    credentials?: MobileMoneyProviderCredentials;
  },
) {
  await assertCapability(sb, userId, input.tenantId, "mobile_money.manage");

  const providerCode = mobileMoneyProviderCodeSchema.parse(input.providerCode);
  const provider = getMobileMoneyProvider(providerCode);
  if (!provider) throw new Error("Unsupported Mobile Money provider.");

  const enabledNetworks = normalizeNetworks(input.enabledNetworks);
  if (enabledNetworks.length === 0) throw new Error("Select at least one Mobile Money network.");

  for (const network of enabledNetworks) {
    if (!provider.supportedNetworks.includes(network)) {
      throw new Error(provider.name + " does not support " + network + ".");
    }
  }

  const { data: existing } = await sb
    .from("restaurant_mobile_money_provider_connections")
    .select("credential_ciphertext, credential_iv, credential_tag, provider_code, provider_config")
    .eq("tenant_id", input.tenantId)
    .maybeSingle();

  const credentials = input.credentials && Object.keys(input.credentials).length
    ? input.credentials
    : null;

  if (credentials) validateCredentials(providerCode, credentials);
  else if (
    !existing?.credential_ciphertext ||
    existing.provider_code !== providerCode
  ) {
    throw new Error("Enter the credentials for the selected Mobile Money provider.");
  }

  const configured = { ...(input.config ?? {}) };
  if (providerCode === "payin" && !configured.callbackUrl) {
    try {
      const origin = resolvePublicOrigin(
        getRequestHeader("host"),
        getRequestHeader("x-forwarded-proto") ?? "https",
      );
      configured.callbackUrl = `${origin}/api/mobile-money-webhook/${providerCode}`;
    } catch {
      // Credentials may still be saved; callback can be supplied later.
    }
  }

  const encrypted = credentials ? encryptSecret(JSON.stringify(credentials)) : null;
  const row: Record<string, unknown> = {
    tenant_id: input.tenantId,
    provider_code: providerCode,
    environment: input.environment,
    enabled_networks: enabledNetworks,
    provider_config: configured,
    provider_status: "configured",
    last_provider_error: null,
    updated_at: new Date().toISOString(),
    created_by: userId,
  };

  if (encrypted) {
    row.credential_ciphertext = encrypted.ciphertext;
    row.credential_iv = encrypted.iv;
    row.credential_tag = encrypted.tag;
  }

  const { data, error } = await sb
    .from("restaurant_mobile_money_provider_connections")
    .upsert(row, { onConflict: "tenant_id" })
    .select("id, tenant_id, provider_code, environment, enabled_networks, provider_config, provider_status, credential_ciphertext")
    .single();

  if (error) throw new Error(error.message);

  // Keep outlet payment rows aligned with the tenant's provider metadata.
  // Credentials remain tenant-only; this is only a provider/environment
  // snapshot used by collection records and legacy operational reads.
  const { error: outletSyncError } = await sb
    .from("restaurant_mobile_money_accounts")
    .update({
      provider_code: providerCode,
      environment: input.environment,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", input.tenantId)
    .eq("mode", "connected");
  if (outletSyncError) throw new Error(outletSyncError.message);

  return {
    id: data.id,
    tenantId: data.tenant_id,
    providerCode: data.provider_code,
    environment: data.environment,
    enabledNetworks: normalizeNetworks(data.enabled_networks),
    config: (data.provider_config ?? {}) as MobileMoneyProviderConfig,
    credentialsConfigured: Boolean(data.credential_ciphertext),
    providerStatus: data.provider_status,
  };
}

/** Server-only. Prefers the tenant connection; outlet connection is legacy fallback. */
export async function getMobileMoneyProviderCredentials(
  supabaseAdmin: Sb,
  tenantId: string,
  locationId: string,
): Promise<{
  providerCode: MobileMoneyProviderCode;
  environment?: MobileMoneyEnvironment;
  enabledNetworks?: MobileMoneyNetwork[];
  config: MobileMoneyProviderConfig;
  credentials: MobileMoneyProviderCredentials;
} | null> {
  const { data: tenantConnection } = await supabaseAdmin
    .from("restaurant_mobile_money_provider_connections")
    .select("provider_code, environment, enabled_networks, provider_config, credential_ciphertext, credential_iv, credential_tag")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const source = tenantConnection?.credential_ciphertext
    ? tenantConnection
    : (await supabaseAdmin
        .from("restaurant_mobile_money_accounts")
        .select("provider_code, environment, provider_config, credential_ciphertext, credential_iv, credential_tag")
        .eq("tenant_id", tenantId)
        .eq("location_id", locationId)
        .maybeSingle()).data;

  if (!source?.credential_ciphertext) return null;

  const providerCode = mobileMoneyProviderCodeSchema.safeParse(source.provider_code);
  if (!providerCode.success) return null;

  const plaintext = decryptSecret({
    ciphertext: source.credential_ciphertext,
    iv: source.credential_iv,
    tag: source.credential_tag,
  });

  let credentials: MobileMoneyProviderCredentials;
  try {
    credentials = JSON.parse(plaintext);
  } catch {
    throw new Error("Stored Mobile Money provider credentials are invalid.");
  }

  return {
    providerCode: providerCode.data,
    environment: source.environment as MobileMoneyEnvironment | undefined,
    enabledNetworks: normalizeNetworks(source.enabled_networks),
    config: (source.provider_config ?? {}) as MobileMoneyProviderConfig,
    credentials,
  };
}

/** Legacy outlet-level configuration retained for backward compatibility. */
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
    } catch {}
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

/** Tests the tenant connection without creating a payment. */
export async function testMobileMoneyTenantProviderConnection(
  sb: Sb,
  userId: string,
  input: { tenantId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "mobile_money.manage");
  const { data } = await sb
    .from("restaurant_mobile_money_provider_connections")
    .select("provider_code, environment, provider_config, credential_ciphertext, credential_iv, credential_tag")
    .eq("tenant_id", input.tenantId)
    .maybeSingle();

  if (!data?.credential_ciphertext) {
    throw new Error("Connect a Mobile Money provider before testing the connection.");
  }

  const providerCode = mobileMoneyProviderCodeSchema.safeParse(data.provider_code);
  if (!providerCode.success) throw new Error("Unsupported Mobile Money provider.");

  const provider = getMobileMoneyProvider(providerCode.data);
  if (!provider?.implemented) throw new Error("This provider connector is not implemented yet.");
  if (data.environment === "production" && !provider.certified) {
    throw new Error("This provider is not production-certified for LexiBite yet.");
  }

  const plaintext = decryptSecret({
    ciphertext: data.credential_ciphertext,
    iv: data.credential_iv,
    tag: data.credential_tag,
  });
  const credentials = JSON.parse(plaintext) as MobileMoneyProviderCredentials;

  if (providerCode.data === "payin") {
    const { createPayInAdapter } = await import("./providers/payinAdapter.server");
    const adapter = createPayInAdapter(
      data.environment as MobileMoneyEnvironment,
      credentials,
      (data.provider_config ?? {}) as MobileMoneyProviderConfig,
    );
    const health = await adapter.healthCheck();
    await sb
      .from("restaurant_mobile_money_provider_connections")
      .update({
        provider_status: health.ok ? "operational" : "error",
        last_health_check_at: new Date().toISOString(),
        last_provider_error: health.ok ? null : health.detail,
      })
      .eq("tenant_id", input.tenantId);
    if (!health.ok) throw new Error(health.message || "Provider connection failed.");
    return { ok: true, providerCode: providerCode.data, message: "Connected" };
  }

  throw new Error("This provider connector does not yet support connection testing.");
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
