/**
 * LexiBite Demo Access — Vercel Function entry point.
 *
 * This repository's deployed public webhook/API endpoints use Vercel
 * Functions under /api. TanStack Start server-route support is not present
 * in the installed router version, so the P02 public API is exposed here
 * without changing the authoritative demo handler.
 */
import { handleDemoPublicApi } from "../../../src/modules/lexibite-demo/http.server";

export default async function handler(request: Request): Promise<Response> {
  return (
    (await handleDemoPublicApi(request)) ??
    new Response(JSON.stringify({ status: "error", message: "Not found." }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  );
}
