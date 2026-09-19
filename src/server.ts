/**
 * P08-A / P08 — the application's server entry point.
 *
 * TanStack Start auto-generates a default server entry (a virtual module)
 * when no `src/server.{ts,tsx}` exists — that default entry ONLY dispatches
 * to the TanStack Router route tree, which renders pages and resolves
 * `createServerFn` RPC calls. It has no mechanism to answer a plain external
 * HTTP request with raw JSON outside that RPC protocol.
 *
 * Creating this file is the framework's own documented override point
 * (`@tanstack/start-server-core`'s resolveEntry, `defaultEntry: "server"`):
 * this file's default export becomes the actual Fetch-API request handler
 * the deployed runtime (Nitro/Cloudflare Worker, confirmed via the existing
 * build output) calls for every incoming request. Wrapping — not replacing —
 * the framework's own `createStartHandler` means every existing page route
 * and server function keeps working exactly as before; this only adds new
 * branches, checked first, for genuine external HTTP endpoints.
 *
 * `/api/v1/health` (P08-A) proved the mechanism: no auth, no tenant data,
 * no secrets, no domain logic. P08 adds the real, authenticated, tenant-
 * scoped surface on top of it — `src/modules/api-platform/router.server.ts`
 * owns everything past this point (auth, entitlement, rate/quota, request
 * validation, idempotency, dispatch to the existing domain server modules);
 * this file only routes by path prefix and stays free of business logic
 * itself, exactly as the ADR anticipated.
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

const startHandler = createStartHandler(defaultStreamHandler);

const SERVICE = "lexibite-api";
const API_VERSION = "v1";

function healthResponse(): Response {
  const body = JSON.stringify({
    ok: true,
    service: SERVICE,
    version: API_VERSION,
    timestamp: new Date().toISOString(),
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/v1/health") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
          status: 405,
          headers: { "content-type": "application/json; charset=utf-8", allow: "GET" },
        });
      }
      return healthResponse();
    }

    // P02 — LexiBite Demo Access public API for Nolmark/Lovable. See
    // src/modules/lexibite-demo/http.server.ts and
    // docs/p02/README-nolmark-integration.md for the full contract.
    if (url.pathname.startsWith("/api/public/demo/")) {
      const { handleDemoPublicApi } = await import("./modules/lexibite-demo/http.server");
      const response = await handleDemoPublicApi(request);
      if (response) return response;
    }

    // Internal, non-public route (webhook retry / idempotency-cleanup
    // dispatch) — checked before the general /api/v1/ branch since it is
    // not part of the customer-facing credentialed surface.
    if (url.pathname === "/api/v1/_internal/dispatch") {
      const { handleInternalDispatchRequest } =
        await import("@/modules/api-platform/router.server");
      return handleInternalDispatchRequest(request);
    }

    if (url.pathname.startsWith("/api/v1/")) {
      const { handleApiV1Request } = await import("@/modules/api-platform/router.server");
      return handleApiV1Request(request);
    }

    return startHandler(request);
  },
};
