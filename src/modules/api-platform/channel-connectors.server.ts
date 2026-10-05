import { getIntegrationSecret } from "./integrations.server";
import { assertChannelProvider } from "./channel-registry.server";
import { getChannelAdapter } from "./adapters/index.server";
import type { ChannelHealth } from "./adapters/channel-adapter.server";
import type { ChannelProviderKey } from "./channel-contracts";

export { type ChannelHealth };

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
    .eq("integration_type", "channel")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Channel connection not found.");

  const provider = assertChannelProvider(data.provider);
  const adapter = getChannelAdapter(provider.key);

  if (data.status === "disabled") {
    return {
      ok: false,
      provider: provider.key,
      status: null,
      message: "Channel connection is disabled.",
      checkedAt: new Date().toISOString(),
    };
  }

  const credential = await getIntegrationSecret(supabaseAdmin, tenantId, integrationId);
  if (!credential) {
    return {
      ok: false,
      provider: provider.key,
      status: null,
      message: "No provider credential is configured.",
      checkedAt: new Date().toISOString(),
    };
  }

  const config = adapter.validateConfig(data.config ?? {});
  return adapter.testConnection(config, credential);
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

export type { ChannelProviderKey };
