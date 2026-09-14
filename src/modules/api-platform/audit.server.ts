/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P08 — per-request observability for the external API, plus a simple
 * sliding-window rate limiter built on the same log this writes (no new
 * infrastructure: reuses api_request_log rather than adding a separate
 * counter store). Daily/monthly volume is governed by the commercial quota
 * engine instead (see router.server.ts's use of
 * src/modules/commercial/quota.server.ts) — this module only bounds burst
 * rate within a single minute.
 */
import { ApiError } from "./errors";

type Sb = any;

export interface ApiRequestLogEntry {
  requestId: string;
  tenantId: string | null;
  propertyId: string | null;
  credentialId: string | null;
  method: string;
  endpoint: string;
  statusCode: number;
  durationMs: number;
  errorCode?: string | null;
  ip: string | null;
}

/** Never allowed to fail the request it's attached to — matches writeCommercialAudit's own best-effort contract. */
export async function writeApiRequestLog(
  supabaseAdmin: Sb,
  entry: ApiRequestLogEntry,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("api_request_log").insert({
      request_id: entry.requestId,
      tenant_id: entry.tenantId,
      property_id: entry.propertyId,
      credential_id: entry.credentialId,
      method: entry.method,
      endpoint: entry.endpoint,
      status_code: entry.statusCode,
      duration_ms: entry.durationMs,
      error_code: entry.errorCode ?? null,
      ip: entry.ip,
    });
    if (error)
      console.warn("[api-platform] request log not recorded", entry.requestId, error.message);
  } catch (err) {
    console.warn("[api-platform] request log not recorded", entry.requestId, err);
  }
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;

/** Sliding one-minute window per credential, counted off the request log itself. */
export async function assertWithinRateLimit(
  supabaseAdmin: Sb,
  credentialId: string,
): Promise<void> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count } = await supabaseAdmin
    .from("api_request_log")
    .select("id", { count: "exact", head: true })
    .eq("credential_id", credentialId)
    .gte("created_at", since);
  if ((count ?? 0) >= RATE_LIMIT_MAX_REQUESTS) {
    throw new ApiError(
      "rate_limited",
      `Rate limit exceeded: max ${RATE_LIMIT_MAX_REQUESTS} requests per minute per credential.`,
    );
  }
}
