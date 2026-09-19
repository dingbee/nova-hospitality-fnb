/**
 * LexiBite Demo Access — public HTTP surface for Nolmark/Lovable.
 *
 * Genuine raw HTTP (not a TanStack Start server function): Nolmark is a
 * different origin and cannot address this app's createServerFn RPC
 * protocol, exactly the same reasoning documented in src/server.ts for why
 * that file exists at all (see api/pesapal-ipn.ts / api/mobile-money-
 * webhook.ts for this codebase's other genuinely-public raw endpoints).
 *
 * Every handler here treats the request body as untrusted, validates it
 * with the same zod schemas used everywhere else in the codebase, and
 * never accepts a tenant id, role, or any other authorization-relevant
 * value from the caller — see contracts.ts (no such fields exist on these
 * schemas at all).
 */
import { registerDemoProspectSchema, resendDemoVerificationSchema } from "./contracts";

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(extraHeaders ?? {}) },
  });
}

function corsHeaders(request: Request): Record<string, string> {
  const allowed = (process.env.NOLMARK_ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin");
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function clientIp(request: Request): string | null {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip");
}

function appOrigin(request: Request): string {
  return process.env.LEXIBITE_APP_ORIGIN ?? new URL(request.url).origin;
}

/** Returns a Response if this request was handled, or null if the path doesn't match. */
export async function handleDemoPublicApi(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/public/demo/")) return null;

  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (url.pathname === "/api/public/demo/register" && request.method === "POST") {
    let parsed;
    try {
      parsed = registerDemoProspectSchema.parse(await request.json());
    } catch {
      return json({ status: "error", message: "Invalid registration payload." }, 400, cors);
    }
    const mod = await import("./registration.server");
    try {
      const result = await mod.registerDemoProspect(supabaseAdmin, parsed, {
        ip: clientIp(request),
        origin: appOrigin(request),
      });
      const httpStatus = result.status === "error" ? 422 : 200;
      return json(result, httpStatus, cors);
    } catch {
      return json(
        { status: "error", registrationId: null, message: "Couldn't register your demo request." },
        500,
        cors,
      );
    }
  }

  if (url.pathname === "/api/public/demo/resend" && request.method === "POST") {
    let parsed;
    try {
      parsed = resendDemoVerificationSchema.parse(await request.json());
    } catch {
      return json({ status: "error", message: "Invalid request." }, 400, cors);
    }
    const mod = await import("./registration.server");
    try {
      const result = await mod.resendDemoVerification(supabaseAdmin, parsed.workEmail, {
        origin: appOrigin(request),
      });
      return json(result, 200, cors);
    } catch {
      return json(
        {
          status: "error",
          registrationId: null,
          message: "Couldn't resend the verification email.",
        },
        500,
        cors,
      );
    }
  }

  const statusMatch = url.pathname.match(/^\/api\/public\/demo\/registration\/([0-9a-f-]{36})$/i);
  if (statusMatch && request.method === "GET") {
    const mod = await import("./registration.server");
    const result = await mod.getDemoRegistrationStatus(supabaseAdmin, statusMatch[1]!);
    if (!result) return json({ status: "error", message: "Not found." }, 404, cors);
    return json(result, 200, cors);
  }

  return json({ status: "error", message: "Not found." }, 404, cors);
}
