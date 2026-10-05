import { assertCapability } from "@/modules/restaurant/core/access.server";
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { writeCommercialAudit } from "@/modules/commercial/audit.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  createChannelConnectionSchema,
  type CreateChannelConnectionInput,
  type UpdateChannelConnectionInput,
} from "./channel-contracts";
import { assertChannelProvider, normaliseChannelConfig } from "./channel-registry.server";
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

export async function createChannelConnection(
  sb: any,
  userId: string,
  input: CreateChannelConnectionInput,
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId ?? undefined,
  });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", {
    propertyId: input.propertyId ?? null,
  });

  const provider = assertChannelProvider(input.providerKey);
  const config = normaliseChannelConfig(input.providerKey, input.config);

  return registerIntegration(sb, userId, {
    tenantId: input.tenantId,
    propertyId: input.propertyId ?? null,
    provider: provider.key,
    integrationType: "channel",
    label: input.label,
    config,
    secret: input.apiKey,
  });
}

export async function updateChannelConnection(
  sb: any,
  userId: string,
  input: UpdateChannelConnectionInput,
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId ?? undefined,
  });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", {
    propertyId: input.propertyId ?? null,
  });

  const config = input.config ? normaliseChannelConfig("ordering.co", {
    projectId: input.config.projectId ?? "",
    languageCode: input.config.languageCode ?? "en",
    businessId: input.config.businessId,
    baseUrl: input.config.baseUrl ?? "https://api.ordering.co",
  }) : undefined;

  return updateIntegration(sb, userId, {
    tenantId: input.tenantId,
    integrationId: input.integrationId,
    label: input.label,
    config,
    secret: input.apiKey,
    status: input.status,
  });
}

export async function testChannelConnectionForTenant(
  userId: string,
  input: { tenantId: string; integrationId: string },
) {
  // Authorization is evaluated on the RLS-scoped client before the server-only
  // secret is ever decrypted.
  const { createSupabaseClient } = await import("@/integrations/supabase/client.server");
  const sb = createSupabaseClient();
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
