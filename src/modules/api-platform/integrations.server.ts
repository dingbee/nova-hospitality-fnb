/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P08 — Integration Registry.
 *
 * A generic identity/config/status/secret/audit record for a third-party
 * integration a tenant has connected. Deliberately provider-agnostic: this
 * module never talks to any specific provider's API (see CLAUDE.md — "Avoid
 * building provider-specific logic directly into unrelated modules"). A
 * future provider adapter reads its own connection details via
 * getIntegrationSecret/config, entirely outside this file.
 */
import { assertCapability } from "@/modules/restaurant/core/access.server";
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { writeCommercialAudit } from "@/modules/commercial/audit.server";
import { decryptSecret, encryptSecret } from "./crypto.server";
import type { RegisterIntegrationInput, UpdateIntegrationInput } from "./contracts";

type Sb = any;

const SAFE_COLUMNS =
  "id, provider, integration_type, label, status, config, property_id, last_error, last_synced_at, created_at, updated_at";

export async function registerIntegration(sb: Sb, userId: string, input: RegisterIntegrationInput) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId ?? undefined,
  });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", {
    propertyId: input.propertyId ?? null,
  });

  const secretFields = input.secret ? encryptSecret(input.secret) : null;
  const { data, error } = await sb
    .from("api_integrations")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      provider: input.provider,
      integration_type: input.integrationType,
      label: input.label,
      config: input.config,
      secret_ciphertext: secretFields?.ciphertext ?? null,
      secret_iv: secretFields?.iv ?? null,
      secret_tag: secretFields?.tag ?? null,
      created_by: userId,
      status: "active",
    })
    .select(SAFE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "api_integration.registered",
    entityType: "api_integration",
    entityId: data.id,
    tenantId: input.tenantId,
    after: { provider: input.provider, integrationType: input.integrationType, label: input.label },
  });
  return data;
}

export async function listIntegrations(sb: Sb, userId: string, input: { tenantId: string }) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { data, error } = await sb
    .from("api_integrations")
    .select(SAFE_COLUMNS)
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function updateIntegration(sb: Sb, userId: string, input: UpdateIntegrationInput) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.label !== undefined) patch.label = input.label;
  if (input.config !== undefined) patch.config = input.config;
  if (input.status !== undefined) patch.status = input.status;
  if (input.secret !== undefined) {
    const enc = encryptSecret(input.secret);
    patch.secret_ciphertext = enc.ciphertext;
    patch.secret_iv = enc.iv;
    patch.secret_tag = enc.tag;
  }
  const { data, error } = await sb
    .from("api_integrations")
    .update(patch)
    .eq("id", input.integrationId)
    .eq("tenant_id", input.tenantId)
    .select(SAFE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Integration not found or does not belong to this tenant.");

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "api_integration.updated",
    entityType: "api_integration",
    entityId: input.integrationId,
    tenantId: input.tenantId,
  });
  return data;
}

/**
 * Server-only decrypted-secret accessor for a future provider adapter.
 * Never called from any admin-facing or external API response path — the
 * raw secret must never leave this process boundary serialized in a
 * response.
 */
export async function getIntegrationSecret(
  supabaseAdmin: Sb,
  tenantId: string,
  integrationId: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("api_integrations")
    .select("secret_ciphertext, secret_iv, secret_tag")
    .eq("id", integrationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data?.secret_ciphertext) return null;
  return decryptSecret({
    ciphertext: data.secret_ciphertext,
    iv: data.secret_iv,
    tag: data.secret_tag,
  });
}
