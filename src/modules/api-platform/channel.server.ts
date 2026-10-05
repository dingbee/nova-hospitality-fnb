import { assertCapability } from "@/modules/restaurant/core/access.server";
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { writeCommercialAudit } from "@/modules/commercial/audit.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UpdateChannelConnectionInput, CreateChannelConnectionInput } from "./channel-contracts";
import { assertChannelProvider, getChannelProvider } from "./channel-registry.server";
import { getChannelDefinition } from "./channel-catalog";
import { getChannelAdapter } from "./adapters/index.server";
import { registerIntegration, updateIntegration } from "./integrations.server";
import { testChannelConnection, persistChannelHealth } from "./channel-connectors.server";

export async function listChannelConnections(sb: any, userId: string, input: { tenantId: string }) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { data, error } = await sb
    .from("api_integrations")
    .select("id, provider, integration_type, label, status, config, property_id, last_error, last_synced_at, created_at, updated_at")
    .eq("tenant_id", input.tenantId)
    .eq("integration_type", "channel")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row: any) => ({
    id: row.id,
    tenantId: input.tenantId,
    propertyId: row.property_id,
    providerKey: row.provider,
    label: row.label,
    status: row.status,
    config: row.config,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function createChannelConnection(sb: any, userId: string, input: CreateChannelConnectionInput) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId ?? undefined,
  });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", {
    propertyId: input.propertyId ?? null,
  });

  const channel = getChannelDefinition(input.channelKey);
  if (!channel) throw new Error(`Unsupported channel: ${input.channelKey}`);
  const provider = assertChannelProvider(channel.providerKey);
  const adapter = getChannelAdapter(provider.key);
  const config = adapter.validateConfig(input.config);

  return registerIntegration(sb, userId, {
    tenantId: input.tenantId,
    propertyId: input.propertyId ?? null,
    provider: provider.key,
    integrationType: "channel",
    label: input.label,
    config,
    secret: input.credential,
  });
}

export async function updateChannelConnection(sb: any, userId: string, input: UpdateChannelConnectionInput) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId ?? undefined,
  });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", {
    propertyId: input.propertyId ?? null,
  });

  const { data: existing, error } = await sb
    .from("api_integrations")
    .select("provider, config")
    .eq("id", input.integrationId)
    .eq("tenant_id", input.tenantId)
    .eq("integration_type", "channel")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!existing) throw new Error("Channel connection not found.");

  const provider = assertChannelProvider(existing.provider);
  const adapter = getChannelAdapter(provider.key);
  const config = input.config !== undefined
    ? adapter.validateConfig({ ...(existing.config ?? {}), ...input.config })
    : undefined;

  return updateIntegration(sb, userId, {
    tenantId: input.tenantId,
    integrationId: input.integrationId,
    propertyId: input.propertyId,
    label: input.label,
    config,
    secret: input.credential,
    status: input.status,
  });
}

export async function testChannelConnectionForTenant(
  sb: SupabaseClient<any, any, any>,
  userId: string,
  input: { tenantId: string; integrationId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");

  const health = await testChannelConnection(supabaseAdmin, input.tenantId, input.integrationId);
  await persistChannelHealth(supabaseAdmin, input.tenantId, input.integrationId, health);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: health.ok ? "channel_connection.test_succeeded" : "channel_connection.test_failed",
    entityType: "api_integration",
    entityId: input.integrationId,
    tenantId: input.tenantId,
    after: { provider: health.provider, status: health.status, message: health.message },
  });

  return health;
}
