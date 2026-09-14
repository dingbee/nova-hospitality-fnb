/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary, matching every other *.server.ts module. */
/**
 * P08 — API credential lifecycle.
 *
 * Every credential is backed by a synthetic `restaurant_members` row (see
 * standalone/db/migrations/0058_p08_api_integration_platform.sql's header
 * comment, decision #3, and 0057's role comment) so that the EXISTING
 * `assertCapability`/`assertTenantRead` guards in every domain *.server.ts
 * module enforce the credential's scope with zero duplicated logic — this
 * module never re-implements order/menu/location authorization, it only
 * resolves which (service_user_id, tenantId, propertyId) a presented
 * credential maps to.
 *
 * Human-facing lifecycle (issue/list/revoke) runs on the RLS-scoped caller
 * client and is gated by the "tenant.manage" RestaurantCapability (owner/
 * general_manager only — src/modules/restaurant/core/permissions.ts).
 * `resolveCredential` is the one function the external API pipeline itself
 * calls, always with the service-role admin client (a credential has no
 * Supabase JWT for RLS to key on — see the ADR's §13).
 */
import { randomUUID } from "node:crypto";
import { assertCapability } from "@/modules/restaurant/core/access.server";
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { writeCommercialAudit } from "@/modules/commercial/audit.server";
import { generateApiKey, hashesEqual, parseApiKeyToken, sha256Hex } from "./crypto.server";
import type { ApiScope, IssueCredentialInput } from "./contracts";

type Sb = any;

/**
 * A write scope needs the 'api_service' role (grants exactly "sales.manage",
 * see permissions.ts); a purely read-scoped credential gets 'viewer' (zero
 * capabilities beyond tenant membership) so a bug in the app-layer scope
 * check can never let a read-only credential write — the DB-level
 * assertCapability check independently refuses it.
 */
function serviceRoleForScopes(scopes: readonly ApiScope[]): "viewer" | "api_service" {
  return scopes.some((s) => s.endsWith(":write")) ? "api_service" : "viewer";
}

export async function issueCredential(sb: Sb, userId: string, input: IssueCredentialInput) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId ?? undefined,
  });
  await assertEntitled(sb, input.tenantId, "api_access", { propertyId: input.propertyId ?? null });

  const generated = generateApiKey();
  const serviceUserId = randomUUID();
  const role = serviceRoleForScopes(input.scopes);

  const { error: memberError } = await sb.from("restaurant_members").insert({
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    user_id: serviceUserId,
    role,
  });
  if (memberError) throw new Error(memberError.message);

  const { data, error } = await sb
    .from("api_credentials")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      service_user_id: serviceUserId,
      label: input.label,
      key_prefix: generated.prefix,
      key_hash: generated.hash,
      scopes: input.scopes,
      created_by: userId,
      expires_at: input.expiresAt ?? null,
    })
    .select("id, label, key_prefix, scopes, status, property_id, created_at, expires_at")
    .single();
  if (error) {
    // Best-effort cleanup — an orphaned service-account row with no
    // credential can never be reached (no secret exists for it), but leave
    // no stray row behind when we don't have to.
    await sb
      .from("restaurant_members")
      .delete()
      .eq("tenant_id", input.tenantId)
      .eq("user_id", serviceUserId);
    throw new Error(error.message);
  }

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "api_credential.issued",
    entityType: "api_credential",
    entityId: data.id,
    tenantId: input.tenantId,
    after: { label: input.label, scopes: input.scopes, propertyId: input.propertyId ?? null },
  });

  // The only response that ever carries the raw secret. Every later read
  // (listCredentials) selects key_prefix only, never key_hash or the token.
  return { ...data, token: generated.token };
}

export async function listCredentials(sb: Sb, userId: string, input: { tenantId: string }) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { data, error } = await sb
    .from("api_credentials")
    .select(
      "id, label, key_prefix, scopes, status, property_id, created_at, expires_at, revoked_at, last_used_at, last_used_ip",
    )
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function revokeCredential(
  sb: Sb,
  userId: string,
  input: { tenantId: string; credentialId: string; reason: string },
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { data, error } = await sb
    .from("api_credentials")
    .update({
      status: "revoked",
      revoked_at: new Date().toISOString(),
      revoked_by: userId,
      revoked_reason: input.reason,
    })
    .eq("id", input.credentialId)
    .eq("tenant_id", input.tenantId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data)
    throw new Error("Credential not found, already revoked, or does not belong to this tenant.");

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "api_credential.revoked",
    entityType: "api_credential",
    entityId: input.credentialId,
    tenantId: input.tenantId,
    reason: input.reason,
  });
  return { ok: true };
}

export interface ResolvedCredential {
  id: string;
  tenantId: string;
  propertyId: string | null;
  serviceUserId: string;
  scopes: ApiScope[];
}

/**
 * Resolves a presented `Authorization: Bearer <token>` value to its
 * credential — always called with the service-role admin client. Returns
 * null for anything that isn't a live, non-expired, non-revoked credential
 * with a matching secret hash; never distinguishes "no such prefix" from
 * "wrong secret" from "revoked" from "expired" in its return value, so the
 * router's 401 response can't be used to enumerate which failure mode
 * applies (see router.server.ts).
 */
export async function resolveCredential(
  supabaseAdmin: Sb,
  token: string,
): Promise<ResolvedCredential | null> {
  const parsed = parseApiKeyToken(token);
  if (!parsed) return null;

  const { data } = await supabaseAdmin
    .from("api_credentials")
    .select("id, tenant_id, property_id, service_user_id, scopes, status, key_hash, expires_at")
    .eq("key_prefix", parsed.prefix)
    .maybeSingle();
  if (!data) return null;
  if (data.status !== "active") return null;
  if (data.expires_at && new Date(data.expires_at as string).getTime() <= Date.now()) return null;
  if (!hashesEqual(sha256Hex(parsed.secret), data.key_hash as string)) return null;

  return {
    id: data.id as string,
    tenantId: data.tenant_id as string,
    propertyId: (data.property_id as string | null) ?? null,
    serviceUserId: data.service_user_id as string,
    scopes: data.scopes as string[] as ApiScope[],
  };
}

/** Fire-and-forget last-used bookkeeping — never allowed to fail the request it's attached to. */
export async function touchCredentialUsage(
  supabaseAdmin: Sb,
  credentialId: string,
  ip: string | null,
) {
  try {
    await supabaseAdmin
      .from("api_credentials")
      .update({ last_used_at: new Date().toISOString(), last_used_ip: ip })
      .eq("id", credentialId);
  } catch {
    // best-effort only
  }
}
