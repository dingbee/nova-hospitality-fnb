/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P08 — idempotency for externally initiated transactional requests.
 *
 * Semantics (mirrors the existing client_request_id pattern used throughout
 * the codebase — e.g. pos.server.ts's openPosOrder/addPosLines — but generic
 * across every POST/PATCH /api/v1 endpoint via the standard `Idempotency-Key`
 * request header, not just order creation):
 *
 *  - Same key + same request (method, path, body) -> the ORIGINAL response is
 *    replayed verbatim; the handler never runs a second time.
 *  - Same key + a DIFFERENT request -> 409 idempotency_conflict. A key is a
 *    promise about one specific request, not a namespace a caller can reuse
 *    for something else.
 *  - Two concurrent requests racing on the same never-seen-before key -> the
 *    loser sees a 409 conflict (a legitimate retry after that returns the
 *    winner's completed response, once the winner finishes) rather than
 *    both executing the underlying mutation.
 *  - Records are retained 24h (`api_idempotency_records.expires_at`) and
 *    purged by `public.api_purge_expired_idempotency_records()` — bounded
 *    retention, not unbounded growth.
 */
import { createHash } from "node:crypto";
import { ApiError } from "./errors";

type Sb = any;

export function requestFingerprint(method: string, path: string, body: unknown): string {
  const normalized = JSON.stringify(body ?? null);
  return createHash("sha256").update(`${method}\n${path}\n${normalized}`, "utf8").digest("hex");
}

export interface IdempotentResult {
  status: number;
  body: unknown;
}

/**
 * Runs `handler` under idempotency protection. When `idempotencyKey` is
 * absent, runs `handler` directly with no dedup (not every endpoint needs
 * it — GETs and other non-mutating calls never receive one from the
 * router). Returns `{ replayed: true, ... }` when an already-completed
 * response was returned without re-running `handler`.
 */
export async function withIdempotency(
  supabaseAdmin: Sb,
  ctx: {
    tenantId: string;
    credentialId: string;
    idempotencyKey: string | null;
    endpoint: string;
    fingerprint: string;
  },
  handler: () => Promise<IdempotentResult>,
): Promise<IdempotentResult & { replayed: boolean }> {
  if (!ctx.idempotencyKey) {
    const result = await handler();
    return { ...result, replayed: false };
  }

  const existing = await findRecord(supabaseAdmin, ctx.tenantId, ctx.idempotencyKey);
  if (existing) return replayOrConflict(existing, ctx.fingerprint);

  const { error: insertError } = await supabaseAdmin.from("api_idempotency_records").insert({
    tenant_id: ctx.tenantId,
    credential_id: ctx.credentialId,
    idempotency_key: ctx.idempotencyKey,
    request_fingerprint: ctx.fingerprint,
    endpoint: ctx.endpoint,
    status: "in_progress",
  });
  if (insertError) {
    if (/duplicate key|unique constraint/i.test(insertError.message)) {
      const winner = await findRecord(supabaseAdmin, ctx.tenantId, ctx.idempotencyKey);
      if (winner) return replayOrConflict(winner, ctx.fingerprint);
    }
    throw new Error(insertError.message);
  }

  try {
    const result = await handler();
    await supabaseAdmin
      .from("api_idempotency_records")
      .update({
        status: "completed",
        response_status: result.status,
        response_body: result.body as any,
        completed_at: new Date().toISOString(),
      })
      .eq("tenant_id", ctx.tenantId)
      .eq("idempotency_key", ctx.idempotencyKey);
    return { ...result, replayed: false };
  } catch (err) {
    // Clear the in_progress marker so a genuine retry after a real failure
    // (not a duplicate) can proceed instead of being stuck behind a
    // permanent "in progress" record.
    await supabaseAdmin
      .from("api_idempotency_records")
      .delete()
      .eq("tenant_id", ctx.tenantId)
      .eq("idempotency_key", ctx.idempotencyKey)
      .eq("status", "in_progress");
    throw err;
  }
}

async function findRecord(supabaseAdmin: Sb, tenantId: string, idempotencyKey: string) {
  const { data } = await supabaseAdmin
    .from("api_idempotency_records")
    .select("status, request_fingerprint, response_status, response_body")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  return data ?? null;
}

function replayOrConflict(
  record: {
    status: string;
    request_fingerprint: string;
    response_status: number | null;
    response_body: unknown;
  },
  fingerprint: string,
): IdempotentResult & { replayed: boolean } {
  if (record.request_fingerprint !== fingerprint) {
    throw new ApiError(
      "idempotency_conflict",
      "This Idempotency-Key was already used with a different request body.",
    );
  }
  if (record.status === "completed") {
    return { replayed: true, status: record.response_status ?? 200, body: record.response_body };
  }
  throw new ApiError("conflict", "A request with this Idempotency-Key is already being processed.");
}
