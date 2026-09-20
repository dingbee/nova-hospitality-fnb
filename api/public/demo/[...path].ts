/**
 * LexiBite Demo Access — explicit Vercel HTTP fallback.
 *
 * The authoritative demo handler remains in
 * src/modules/lexibite-demo/http.server.ts. This thin Vercel Function exists
 * because the hosted Vercel build has historically emitted the application
 * pages while dropping the custom TanStack/Nitro server entry from the public
 * function manifest. Keeping this fallback under /api makes the external
 * Nolmark contract deployable without duplicating any business logic.
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
