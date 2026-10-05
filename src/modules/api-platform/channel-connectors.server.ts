import { getIntegrationSecret, updateIntegration } from "./integrations.server";
import { assertChannelProvider, normaliseChannelConfig } from "./channel-registry.server";
import type { ChannelConnectionConfig, ChannelProviderKey } from "./channel-contracts";

export type ChannelHealth = {
  ok: boolean;
  provider: ChannelProviderKey;
  status: number | null;
  message: string;
  checkedAt: string;
};

const ORDERING_API_BASE = "https://api.ordering.co";

function orderingUrl(config: ChannelConnectionConfig, resource: string) {
  return `${ORDERING_API_BASE}/v400/${encodeURIComponent(config.languageCode)}/${encodeURIComponent(config.projectId)}/${resource}`;
}

async function orderingRequest(
  config: ChannelConnectionConfig,
  apiKey: string,
  resource: string,
): Promise<Response> {
  return fetch(orderingUrl(config, resource), {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

async function testOrderingConnection(
  config: ChannelConnectionConfig,
  apiKey: string,
): Promise<ChannelHealth> {
  const response = await orderingRequest(
    config,
    apiKey,
    "orders?orderBy=-id&page=1&page_size=1&mode=dashboard",
  );
  if (response.ok) {
    return {
      ok: true,
      provider: "ordering.co",
      status: response.status,
      message: "Ordering.co API connection verified.",
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    ok: false,
    provider: "ordering.co",
    status: response.status,
    message:
      response.status === 401 || response.status === 403
        ? "Ordering.co rejected the API key or its project access."
        : `Ordering.co returned HTTP ${response.status}.`,
    checkedAt: new Date().toISOString(),
  };
}

export async function testChannelConnection(
  supabaseAdmin: any,
  tenantId: string,
  integrationId: string,
): Promise<ChannelHealth> {
  const { data, error } = await supabaseAdmin
    .from("api_integrations")
    .select("id, provider, config, status")
    .eq("id", integrationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Channel connection not found.");
  if (data.status === "disabled") {
    return {
      ok: false,
      provider: data.provider as ChannelProviderKey,
      status: null,
      message: "Channel connection is disabled.",
      checkedAt: new Date().toISOString(),
    };
  }

  const provider = assertChannelProvider(data.provider);
  const config = normaliseChannelConfig(provider.key, data.config as ChannelConnectionConfig);
  const secret = await getIntegrationSecret(supabaseAdmin, tenantId, integrationId);
  if (!secret) {
    return {
      ok: false,
      provider: provider.key,
      status: null,
      message: "No provider credential is configured.",
      checkedAt: new Date().toISOString(),
    };
  }

  if (provider.key === "ordering.co") return testOrderingConnection(config, secret);
  throw new Error(`No runtime connector is registered for ${provider.key}`);
}

export async function persistChannelHealth(
  supabaseAdmin: any,
  tenantId: string,
  integrationId: string,
  health: ChannelHealth,
) {
  const patch = {
    status: health.ok ? "active" : "error",
    last_error: health.ok ? null : health.message,
    last_synced_at: health.ok ? health.checkedAt : null,
  };

  const { error } = await supabaseAdmin
    .from("api_integrations")
    .update(patch)
    .eq("id", integrationId)
    .eq("tenant_id", tenantId);

  if (error) throw new Error(error.message);
}
