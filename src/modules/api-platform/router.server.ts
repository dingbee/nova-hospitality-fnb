/**
 * P08 — /api/v1/* external HTTP router.
 *
 * Wired into src/server.ts, which is the framework-native raw HTTP entry
 * point established by P08-A (docs/p08-a-external-http-entry-point-adr.md).
 * Every request that reaches here has already been confirmed to start with
 * "/api/v1/" and NOT be the pre-existing "/api/v1/health" endpoint.
 *
 * Request pipeline, in order (every step required by P08's "External API
 * foundation" acceptance criterion):
 *  1. correlation id (`x-request-id` response header, also the requestId
 *     stamped on the api_request_log row this always writes, success or
 *     failure — see the `finally` block).
 *  2. authentication (Authorization: Bearer <credential>).
 *  3. commercial entitlement (assertEntitled "api_access").
 *  4. rate limiting (per-credential sliding window) + daily quota.
 *  5. request validation (zod, per-endpoint).
 *  6. idempotency (POST endpoints only, via the Idempotency-Key header).
 *  7. dispatch to a thin resources/*.ts handler, which calls into the
 *     EXISTING canonical domain server modules — never a direct DB query
 *     for business data from this file.
 *  8. a single, consistent JSON envelope for every response, success or
 *     error — never a stack trace or an internal error message.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { incrementUsage } from "@/modules/commercial/quota.server";
import {
  resolveCredential,
  touchCredentialUsage,
  type ResolvedCredential,
} from "./credentials.server";
import { assertWithinRateLimit, writeApiRequestLog } from "./audit.server";
import { requestFingerprint, withIdempotency } from "./idempotency.server";
import { ApiError, jsonResponse, toApiErrorBody } from "./errors";
import {
  apiCreateOrderSchema,
  apiListMenuItemsSchema,
  apiListOrdersSchema,
  apiTransitionOrderStatusSchema,
} from "./contracts";
import { apiListLocations } from "./resources/locations";
import { apiListMenuItems, apiListMenus } from "./resources/menus";
import {
  apiCreateOrder,
  apiGetOrder,
  apiListOrders,
  apiTransitionOrderStatus,
} from "./resources/orders";
import { processDueWebhookDeliveries } from "./webhooks.server";

const API_PREFIX = "/api/v1";

function requestIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("validation_failed", "Request body must be valid JSON.");
  }
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError("validation_failed", "Request failed validation.", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || key.trim().length < 6) {
    throw new ApiError(
      "validation_failed",
      "This endpoint requires an Idempotency-Key request header (at least 6 characters).",
    );
  }
  return key.trim();
}

interface RouteResult {
  status: number;
  body: unknown;
}

async function dispatch(
  request: Request,
  path: string,
  credential: ResolvedCredential,
): Promise<RouteResult> {
  const method = request.method;
  const segments = path.slice(API_PREFIX.length).split("/").filter(Boolean);
  const [resource, id, sub] = segments;

  if (segments.length === 1 && resource === "locations") {
    if (method !== "GET")
      throw new ApiError("method_not_allowed", "Only GET is supported on this endpoint.");
    return {
      status: 200,
      body: { ok: true, data: await apiListLocations(supabaseAdmin, credential) },
    };
  }

  if (segments.length === 1 && resource === "menus") {
    if (method !== "GET")
      throw new ApiError("method_not_allowed", "Only GET is supported on this endpoint.");
    return { status: 200, body: { ok: true, data: await apiListMenus(supabaseAdmin, credential) } };
  }

  if (segments.length === 3 && resource === "menus" && sub === "items") {
    if (method !== "GET")
      throw new ApiError("method_not_allowed", "Only GET is supported on this endpoint.");
    const query = parseOrThrow(
      apiListMenuItemsSchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return {
      status: 200,
      body: {
        ok: true,
        data: await apiListMenuItems(supabaseAdmin, credential, { menuId: id, limit: query.limit }),
      },
    };
  }

  if (segments.length === 1 && resource === "orders") {
    if (method === "GET") {
      const query = parseOrThrow(
        apiListOrdersSchema,
        Object.fromEntries(new URL(request.url).searchParams),
      );
      return {
        status: 200,
        body: { ok: true, data: await apiListOrders(supabaseAdmin, credential, query) },
      };
    }
    if (method === "POST") {
      const idempotencyKey = requireIdempotencyKey(request);
      const rawBody = await readJsonBody(request);
      const input = parseOrThrow(apiCreateOrderSchema, rawBody ?? {});
      const fingerprint = requestFingerprint(method, path, rawBody);
      const outcome = await withIdempotency(
        supabaseAdmin,
        {
          tenantId: credential.tenantId,
          credentialId: credential.id,
          idempotencyKey,
          endpoint: path,
          fingerprint,
        },
        async () => {
          const order = await apiCreateOrder(supabaseAdmin, credential, input, idempotencyKey);
          return { status: order.idempotent ? 200 : 201, body: { ok: true, data: order } };
        },
      );
      return { status: outcome.status, body: outcome.body };
    }
    throw new ApiError("method_not_allowed", "Only GET and POST are supported on this endpoint.");
  }

  if (segments.length === 2 && resource === "orders") {
    if (method !== "GET")
      throw new ApiError("method_not_allowed", "Only GET is supported on this endpoint.");
    return {
      status: 200,
      body: { ok: true, data: await apiGetOrder(supabaseAdmin, credential, id) },
    };
  }

  if (segments.length === 3 && resource === "orders" && sub === "status") {
    if (method !== "POST")
      throw new ApiError("method_not_allowed", "Only POST is supported on this endpoint.");
    const idempotencyKey = requireIdempotencyKey(request);
    const rawBody = await readJsonBody(request);
    const input = parseOrThrow(apiTransitionOrderStatusSchema, rawBody ?? {});
    const fingerprint = requestFingerprint(method, path, rawBody);
    const outcome = await withIdempotency(
      supabaseAdmin,
      {
        tenantId: credential.tenantId,
        credentialId: credential.id,
        idempotencyKey,
        endpoint: path,
        fingerprint,
      },
      async () => {
        const result = await apiTransitionOrderStatus(supabaseAdmin, credential, id, input);
        return { status: 200, body: { ok: true, data: result } };
      },
    );
    return { status: outcome.status, body: outcome.body };
  }

  throw new ApiError("not_found", "Unknown endpoint.");
}

export async function handleApiV1Request(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const start = Date.now();
  const path = new URL(request.url).pathname;
  const ip = requestIp(request);

  let tenantId: string | null = null;
  let propertyId: string | null = null;
  let credentialId: string | null = null;
  let statusCode = 200;
  let errorCode: string | null = null;

  try {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (!token) throw new ApiError("unauthorized", "Missing bearer credential.");

    const credential = await resolveCredential(supabaseAdmin, token);
    if (!credential)
      throw new ApiError("unauthorized", "Invalid, revoked, or expired API credential.");
    tenantId = credential.tenantId;
    propertyId = credential.propertyId;
    credentialId = credential.id;

    // Commercial gate: external API access itself must be entitled on this
    // tenant's plan — independent of, and in addition to, whether the
    // credential's own scopes cover a given endpoint.
    await assertEntitled(supabaseAdmin, credential.tenantId, "api_access", {
      propertyId: credential.propertyId,
    });

    await assertWithinRateLimit(supabaseAdmin, credential.id);
    await incrementUsage(supabaseAdmin, credential.tenantId, "api_requests_daily", {
      propertyId: credential.propertyId ?? undefined,
    });

    void touchCredentialUsage(supabaseAdmin, credential.id, ip);

    const result = await dispatch(request, path, credential);
    statusCode = result.status;
    return jsonResponse(result.status, result.body, { "x-request-id": requestId });
  } catch (err) {
    const mapped = toApiErrorBody(err, requestId);
    statusCode = mapped.status;
    errorCode = mapped.body.error.code;
    if (mapped.status === 500) {
      // Server-side only — never serialized into the response (see toApiErrorBody).
      console.error("[api-platform] unhandled error", requestId, err);
    }
    return jsonResponse(mapped.status, mapped.body, { "x-request-id": requestId });
  } finally {
    await writeApiRequestLog(supabaseAdmin, {
      requestId,
      tenantId,
      propertyId,
      credentialId,
      method: request.method,
      endpoint: path,
      statusCode,
      durationMs: Date.now() - start,
      errorCode,
      ip,
    });
  }
}

/**
 * Internal, non-public dispatch route for webhook retry processing and
 * idempotency-record cleanup — see webhooks.server.ts's
 * processDueWebhookDeliveries doc comment for why this exists (no in-repo
 * cron scheduler is available; docs/p08-api-integration-platform.md's
 * "Operational limitations" section documents the external-scheduler
 * requirement). Gated by a bearer secret compared in constant time,
 * entirely separate from the customer-facing credential system above.
 */
export async function handleInternalDispatchRequest(request: Request): Promise<Response> {
  const expected = process.env.NOVA_API_PLATFORM_DISPATCH_SECRET;
  if (!expected) {
    return jsonResponse(503, {
      ok: false,
      error: { code: "internal_error", message: "Dispatch is not configured." },
    });
  }
  const authHeader = request.headers.get("authorization");
  const presented = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const { timingSafeEqual } = await import("node:crypto");
  const match =
    presented !== null &&
    presented.length === expected.length &&
    timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  if (!match) {
    return jsonResponse(401, {
      ok: false,
      error: { code: "unauthorized", message: "Invalid dispatch credential." },
    });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: { code: "method_not_allowed", message: "Only POST is supported." },
    });
  }

  const webhooks = await processDueWebhookDeliveries(supabaseAdmin, 50);
  const { data: purgedCount } = await supabaseAdmin.rpc("api_purge_expired_idempotency_records");
  return jsonResponse(200, {
    ok: true,
    webhookDeliveries: webhooks,
    idempotencyRecordsPurged: purgedCount ?? 0,
  });
}
