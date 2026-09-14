/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P08 — Outbound webhook engine.
 *
 * Endpoint registration/management runs on the RLS-scoped caller client,
 * gated by "tenant.manage" (owner/general_manager only), same as
 * credentials.server.ts and integrations.server.ts. Delivery
 * (enqueueWebhookEvent / deliverWebhookDelivery / processDueWebhookDeliveries)
 * always runs on the service-role admin client — it is triggered from
 * inside the external API pipeline itself (an order was created, not a
 * human action) and from the internal retry-processing route (see
 * router.server.ts).
 *
 * Signing: Stripe-style `t=<unix-seconds>,v1=<hex-hmac-sha256>` in the
 * `Nova-Webhook-Signature` header, over `${timestamp}.${rawBody}` — the
 * recipient re-derives the same HMAC with their own copy of the secret
 * (returned once, at registration/rotation, never again) to verify both
 * authenticity and that the timestamp is recent (replay protection is the
 * recipient's responsibility, same as every other provider using this
 * scheme; the timestamp is provided specifically so they can enforce it).
 *
 * Retry: exponential backoff (30s * 2^attempt, capped at 6h, +jitter),
 * `max_attempts` bounded (default 8), then `dead_letter`. `replayWebhookDelivery`
 * resets a dead-lettered (or any) delivery back to `pending` for one more
 * attempt, preserving its original `event_id` so the recipient's own
 * dedup still recognizes it as the same logical event.
 */
import { createHmac, randomBytes } from "node:crypto";
import { assertCapability } from "@/modules/restaurant/core/access.server";
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { writeCommercialAudit } from "@/modules/commercial/audit.server";
import { ApiError } from "./errors";
import { decryptSecret, encryptSecret, secretDisplayPrefix } from "./crypto.server";
import type { RegisterWebhookEndpointInput, WebhookEventType } from "./contracts";

type Sb = any;

const ENDPOINT_SAFE_COLUMNS =
  "id, url, description, events, status, property_id, integration_id, secret_prefix, created_at, updated_at";

/* ---------------- SSRF guard ---------------- */

const BLOCKED_HOSTNAME_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^\[::1\]$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

/**
 * HTTPS-only + literal private/loopback/link-local address rejection,
 * checked at BOTH registration and every delivery attempt (an endpoint's
 * URL is never trusted just because it passed the check once). This is a
 * literal-address/hostname-pattern check, not a DNS-rebinding-proof
 * resolver — this sandboxed environment has no way to independently verify
 * the Cloudflare Workers runtime's own additional restrictions on `fetch()`
 * targeting internal address ranges, so that platform-level backstop is
 * documented, not relied on, in docs/p08-api-integration-platform.md's
 * "Operational limitations".
 */
export function assertPublicHttpsUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError("validation_failed", "Invalid webhook URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new ApiError("validation_failed", "Webhook URL must use https.");
  }
  if (parsed.username || parsed.password) {
    throw new ApiError("validation_failed", "Webhook URL must not embed credentials.");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAME_PATTERNS.some((p) => p.test(hostname))) {
    throw new ApiError(
      "validation_failed",
      "Webhook URL resolves to a private or internal address.",
    );
  }
}

/* ---------------- Endpoint management (human, RLS-scoped) ---------------- */

export async function registerWebhookEndpoint(
  sb: Sb,
  userId: string,
  input: RegisterWebhookEndpointInput,
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage", {
    propertyId: input.propertyId ?? undefined,
  });
  await assertEntitled(sb, input.tenantId, "advanced_integrations", {
    propertyId: input.propertyId ?? null,
  });
  assertPublicHttpsUrl(input.url);

  const secret = randomBytes(32).toString("base64url");
  const enc = encryptSecret(secret);
  const { data, error } = await sb
    .from("api_webhook_endpoints")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      integration_id: input.integrationId ?? null,
      url: input.url,
      description: input.description ?? null,
      events: input.events,
      secret_ciphertext: enc.ciphertext,
      secret_iv: enc.iv,
      secret_tag: enc.tag,
      secret_prefix: secretDisplayPrefix(secret),
      created_by: userId,
    })
    .select(ENDPOINT_SAFE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "api_webhook_endpoint.registered",
    entityType: "api_webhook_endpoint",
    entityId: data.id,
    tenantId: input.tenantId,
    after: { url: input.url, events: input.events },
  });

  // The only response that ever carries the raw signing secret.
  return { ...data, secret: `whsec_${secret}` };
}

export async function listWebhookEndpoints(sb: Sb, userId: string, input: { tenantId: string }) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { data, error } = await sb
    .from("api_webhook_endpoints")
    .select(ENDPOINT_SAFE_COLUMNS)
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function updateWebhookEndpoint(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    webhookEndpointId: string;
    status?: "active" | "disabled";
    events?: WebhookEventType[];
  },
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.status !== undefined) patch.status = input.status;
  if (input.events !== undefined) patch.events = input.events;
  const { data, error } = await sb
    .from("api_webhook_endpoints")
    .update(patch)
    .eq("id", input.webhookEndpointId)
    .eq("tenant_id", input.tenantId)
    .select(ENDPOINT_SAFE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Webhook endpoint not found or does not belong to this tenant.");

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "api_webhook_endpoint.updated",
    entityType: "api_webhook_endpoint",
    entityId: input.webhookEndpointId,
    tenantId: input.tenantId,
  });
  return data;
}

export async function rotateWebhookSecret(
  sb: Sb,
  userId: string,
  input: { tenantId: string; webhookEndpointId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const secret = randomBytes(32).toString("base64url");
  const enc = encryptSecret(secret);
  const { data, error } = await sb
    .from("api_webhook_endpoints")
    .update({
      secret_ciphertext: enc.ciphertext,
      secret_iv: enc.iv,
      secret_tag: enc.tag,
      secret_prefix: secretDisplayPrefix(secret),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.webhookEndpointId)
    .eq("tenant_id", input.tenantId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Webhook endpoint not found or does not belong to this tenant.");

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "api_webhook_endpoint.secret_rotated",
    entityType: "api_webhook_endpoint",
    entityId: input.webhookEndpointId,
    tenantId: input.tenantId,
  });
  return { id: data.id, secret: `whsec_${secret}` };
}

export async function listWebhookDeliveries(
  sb: Sb,
  userId: string,
  input: { tenantId: string; webhookEndpointId?: string; status?: string; limit: number },
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  let q = sb
    .from("api_webhook_deliveries")
    .select(
      "id, webhook_endpoint_id, event_type, event_id, status, attempt_count, max_attempts, next_attempt_at, last_attempt_at, last_response_status, last_error, delivered_at, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.webhookEndpointId) q = q.eq("webhook_endpoint_id", input.webhookEndpointId);
  if (input.status) q = q.eq("status", input.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function replayWebhookDelivery(
  sb: Sb,
  userId: string,
  input: { tenantId: string; deliveryId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "tenant.manage");
  const { data, error } = await sb
    .from("api_webhook_deliveries")
    .update({
      status: "pending",
      attempt_count: 0,
      next_attempt_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", input.deliveryId)
    .eq("tenant_id", input.tenantId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Delivery not found or does not belong to this tenant.");

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "api_webhook_delivery.replayed",
    entityType: "api_webhook_delivery",
    entityId: input.deliveryId,
    tenantId: input.tenantId,
  });
  return { ok: true };
}

/* ---------------- Dispatch (service-role, non-interactive) ---------------- */

export async function enqueueWebhookEvent(
  supabaseAdmin: Sb,
  params: {
    tenantId: string;
    propertyId: string | null;
    eventType: WebhookEventType;
    payload: unknown;
  },
): Promise<string[]> {
  const { data: endpoints } = await supabaseAdmin
    .from("api_webhook_endpoints")
    .select("id, property_id")
    .eq("tenant_id", params.tenantId)
    .eq("status", "active")
    .contains("events", [params.eventType]);

  const matching = ((endpoints ?? []) as { id: string; property_id: string | null }[]).filter(
    (e) => e.property_id === null || e.property_id === params.propertyId,
  );

  const deliveryIds: string[] = [];
  for (const endpoint of matching) {
    const { data, error } = await supabaseAdmin
      .from("api_webhook_deliveries")
      .insert({
        tenant_id: params.tenantId,
        webhook_endpoint_id: endpoint.id,
        event_type: params.eventType,
        payload: params.payload as any,
      })
      .select("id")
      .single();
    if (!error && data) deliveryIds.push(data.id as string);
  }
  return deliveryIds;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

function computeNextAttempt(attemptCount: number): string {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** attemptCount, BACKOFF_CAP_MS);
  const jitter = Math.floor(Math.random() * 1000);
  return new Date(Date.now() + delay + jitter).toISOString();
}

/** Delivers (or re-attempts) exactly one delivery row. Never throws — every outcome is persisted on the row. */
export async function deliverWebhookDelivery(supabaseAdmin: Sb, deliveryId: string): Promise<void> {
  const { data: delivery } = await supabaseAdmin
    .from("api_webhook_deliveries")
    .select("*")
    .eq("id", deliveryId)
    .maybeSingle();
  if (!delivery || delivery.status === "delivered") return;

  const { data: endpoint } = await supabaseAdmin
    .from("api_webhook_endpoints")
    .select("*")
    .eq("id", delivery.webhook_endpoint_id)
    .maybeSingle();
  if (!endpoint || endpoint.status !== "active") {
    await supabaseAdmin
      .from("api_webhook_deliveries")
      .update({ status: "dead_letter", last_error: "Endpoint disabled or deleted." })
      .eq("id", deliveryId);
    return;
  }

  try {
    assertPublicHttpsUrl(endpoint.url);
  } catch {
    await supabaseAdmin
      .from("api_webhook_deliveries")
      .update({
        status: "dead_letter",
        last_error: "Endpoint URL failed SSRF validation at delivery time.",
      })
      .eq("id", deliveryId);
    return;
  }

  const secret = decryptSecret({
    ciphertext: endpoint.secret_ciphertext,
    iv: endpoint.secret_iv,
    tag: endpoint.secret_tag,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    createdAt: delivery.created_at,
    data: delivery.payload,
  });
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const attemptCount = (delivery.attempt_count as number) + 1;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Nova-Webhook-Signature": `t=${timestamp},v1=${signature}`,
          "Nova-Webhook-Event-Id": delivery.event_id,
          "Nova-Webhook-Event-Type": delivery.event_type,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      await supabaseAdmin
        .from("api_webhook_deliveries")
        .update({
          status: "delivered",
          attempt_count: attemptCount,
          last_attempt_at: new Date().toISOString(),
          last_response_status: response.status,
          delivered_at: new Date().toISOString(),
        })
        .eq("id", deliveryId);
      return;
    }
    throw new Error(`Endpoint responded ${response.status}`);
  } catch (err) {
    const dead = attemptCount >= (delivery.max_attempts as number);
    await supabaseAdmin
      .from("api_webhook_deliveries")
      .update({
        status: dead ? "dead_letter" : "failed",
        attempt_count: attemptCount,
        last_attempt_at: new Date().toISOString(),
        last_error: String((err as Error)?.message ?? err).slice(0, 500),
        next_attempt_at: dead ? delivery.next_attempt_at : computeNextAttempt(attemptCount),
      })
      .eq("id", deliveryId);
  }
}

/**
 * Processes every due delivery (pending, or failed with next_attempt_at in
 * the past), oldest first. Called from the internal dispatch route (see
 * router.server.ts) — this environment has no in-repo cron scheduler (see
 * 0058's header comment #3 in the idempotency-purge section), so an
 * external scheduler must call that route periodically. Documented as an
 * operational limitation, not silently assumed away.
 */
export async function processDueWebhookDeliveries(
  supabaseAdmin: Sb,
  limit = 25,
): Promise<{ processed: number }> {
  const { data: due } = await supabaseAdmin
    .from("api_webhook_deliveries")
    .select("id")
    .in("status", ["pending", "failed"])
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  for (const row of (due ?? []) as { id: string }[]) {
    await deliverWebhookDelivery(supabaseAdmin, row.id);
  }
  return { processed: (due ?? []).length };
}
