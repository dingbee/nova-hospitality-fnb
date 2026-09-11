/**
 * P08-A — the application's server entry point.
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
 * and server function keeps working exactly as before; this only adds one
 * new branch, checked first, for genuine external HTTP endpoints.
 *
 * `/api/v1/health` is the sole endpoint added in this spike. It proves the
 * mechanism: no auth, no tenant data, no secrets, no domain logic — a
 * future P08 would add real API routes as additional branches here (or via
 * a small router of their own), each still delegating to the existing
 * authoritative domain services rather than reimplementing them.
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

    return startHandler(request);
  },
};
