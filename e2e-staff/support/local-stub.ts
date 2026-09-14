/**
 * P09 final certification cycle — deterministic Supabase Auth + PostgREST
 * proxy stub, for real-browser authenticated certification without a real
 * Supabase project or the full local appliance's TLS/bundle/bootstrap
 * flow. Runs only inside this CI job, against a throwaway Postgres +
 * PostgREST pair created and destroyed with it — never touches production.
 *
 * Implements exactly the two Auth endpoints the app's client actually
 * calls (see src/routes/_authenticated.tsx's beforeLoad and
 * src/integrations/supabase/auth-middleware.ts's requireSupabaseAuth):
 *   POST /auth/v1/token?grant_type=password  (supabase.auth.signInWithPassword)
 *   GET  /auth/v1/user                        (supabase.auth.getUser / getClaims's
 *                                               network fallback for a
 *                                               symmetric-key JWT)
 * Everything else (/rest/v1/*) is reverse-proxied to a REAL PostgREST
 * instance — query/filter semantics are never reimplemented here, so this
 * stub cannot mask a real PostgREST-level authorization bug.
 *
 * Tokens are real HS256 JWTs, signed and verified with the same shared
 * secret PostgREST is configured with (PGRST_JWT_SECRET) — PostgREST does
 * its own real signature verification and sets `request.jwt.claims` /
 * SET ROLEs from them; nothing here bypasses that.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.STUB_PORT ?? 4400);
const POSTGREST_URL = process.env.POSTGREST_URL ?? "http://127.0.0.1:3001";
const JWT_SECRET = process.env.STUB_JWT_SECRET;
if (!JWT_SECRET) throw new Error("STUB_JWT_SECRET is required");

/** email -> { password, id } — synthetic, disposable, matches fixtures.sql. */
const CREDENTIALS: Record<string, { password: string; id: string }> = {
  "manager-a1@p09-cert.test": { password: "p09-cert-manager-a1", id: "24ac1cc3-ac6b-402f-bd5b-87830636a644" },
  "owner@p09-cert.test": { password: "p09-cert-owner", id: "7e498502-fcdc-4da7-b1a0-5b3dabdd3dd4" },
  "staff-a1@p09-cert.test": { password: "p09-cert-staff-a1", id: "dde7526a-f217-4859-97b2-78283ddb400d" },
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(claims: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createHmac("sha256", JWT_SECRET!).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

function verifyJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const expected = createHmac("sha256", JWT_SECRET!).update(`${headerB64}.${payloadB64}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, prefer, range",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function userObject(claims: Record<string, unknown>) {
  return {
    id: claims.sub,
    aud: claims.aud ?? "authenticated",
    role: claims.role ?? "authenticated",
    email: claims.email,
    email_confirmed_at: new Date(0).toISOString(),
    phone: "",
    confirmed_at: new Date(0).toISOString(),
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    console.log(`[p09-cert-stub] ${request.method} ${url.pathname}${url.search}`);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/auth/v1/token" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
      const email = (body.email ?? "").trim().toLowerCase();
      const cred = CREDENTIALS[email];
      if (!cred || cred.password !== body.password) {
        return json({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: cred.id,
        email,
        role: "authenticated",
        aud: "authenticated",
        iat: now,
        exp: now + 3600,
      };
      const access_token = signJwt(claims);
      return json({
        access_token,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: `stub-refresh-${cred.id}`,
        user: userObject(claims),
      });
    }

    if (url.pathname === "/auth/v1/user" && request.method === "GET") {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const claims = token ? verifyJwt(token) : null;
      if (!claims) return json({ error: "invalid_token", message: "Invalid or expired token" }, 401);
      return json(userObject(claims));
    }

    if (url.pathname.startsWith("/rest/v1/")) {
      const target = `${POSTGREST_URL}${url.pathname.replace("/rest/v1", "")}${url.search}`;
      const headers = new Headers(request.headers);
      headers.delete("host");
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      });
      const responseHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(CORS_HEADERS)) responseHeaders.set(key, value);
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    }

    return json({ error: "not_found" }, 404);
  },
});

console.log(`[p09-cert-stub] listening on :${PORT} -> PostgREST ${POSTGREST_URL}`);
