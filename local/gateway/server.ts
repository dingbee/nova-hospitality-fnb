/**
 * NOVA Hospitality — Restaurant & Bar OS
 * Local runtime gateway (PRODUCTIZATION-3, Phases 3-5, 9).
 *
 * The ONLY LAN-exposed surface of the appliance. PostgreSQL and PostgREST
 * bind to loopback; every terminal on the LAN talks to this process.
 *
 *   browser terminal ──► gateway ──► PostgREST ──► PostgreSQL
 *                          └──► local auth issuer (ES256)
 *
 * It deliberately mirrors the hosted URL contract (/auth/v1/*, /rest/v1/*) so
 * the frozen application code runs unchanged against either runtime.
 */
import { SQL } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { AuthError, refreshSession, signInWithPassword, signOut, type AuthDeps } from "./auth";
import { LocalAppHost, resolveBundle } from "./app";
import { bootstrapProperty } from "./bootstrap";
import { collectHealth } from "./health";
import { resolveTlsConfig, terminalOrigin } from "../../src/modules/runtime/local/tls";
import { collectSystemInformation } from "./system";

const env = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`Missing required configuration: ${key}`);
  return value;
};

const PORT = Number(env("NOVA_GATEWAY_PORT", "8000"));
const HOST = env("NOVA_GATEWAY_HOST", "0.0.0.0");
const POSTGREST = `http://${env("NOVA_POSTGREST_HOST", "127.0.0.1")}:${env("NOVA_POSTGREST_PORT", "3001")}`;

// ---- application UI ----------------------------------------------------
// Same artefact as the hosted deployment, hosted in-process. Everything that
// is not an API path is the application's to answer.
const appHost = new LocalAppHost(
  resolveBundle(new URL("../..", import.meta.url).pathname, process.env as Record<string, string | undefined>),
);

// ---- TLS ---------------------------------------------------------------
// Android Chrome only treats HTTPS as a secure origin, so the LAN listener is
// TLS whenever certificate material exists. PostgreSQL and PostgREST stay on
// loopback either way; the gateway remains the only LAN surface.
const TLS_CERT_FILE = process.env["NOVA_TLS_CERT_FILE"] ?? "";
const TLS_KEY_FILE = process.env["NOVA_TLS_KEY_FILE"] ?? "";
const tls = resolveTlsConfig(process.env as Record<string, string | undefined>, {
  certPresent: TLS_CERT_FILE !== "" && existsSync(TLS_CERT_FILE),
  keyPresent: TLS_KEY_FILE !== "" && existsSync(TLS_KEY_FILE),
});

const sql = new SQL({
  hostname: env("NOVA_DB_HOST", "127.0.0.1"),
  port: Number(env("NOVA_DB_PORT", "5432")),
  database: env("NOVA_DB_NAME", "nova_local"),
  username: env("NOVA_DB_SUPERUSER", "nova_superuser"),
  password: process.env["NOVA_DB_SUPERUSER_PASSWORD"] ?? "",
  max: 8,
});

const authDeps: AuthDeps = {
  sql,
  privateKeyPem: readFileSync(env("NOVA_JWT_PRIVATE_KEY_FILE"), "utf8"),
  kid: env("NOVA_JWT_KID", "nova-local-1"),
  accessTtlSeconds: Number(env("NOVA_JWT_ACCESS_TTL_SECONDS", "3600")),
  refreshTtlSeconds: Number(env("NOVA_JWT_REFRESH_TTL_SECONDS", "2592000")),
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

/**
 * Sign-in and refresh are the only credential-bearing endpoints, so they carry
 * a per-IP throttle in front of the per-account lockout in the auth issuer.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
function throttled(ip: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new AuthError("Malformed request body", 400);
  }
}

async function proxyToPostgrest(request: Request, path: string): Promise<Response> {
  const url = new URL(request.url);
  const target = `${POSTGREST}${path}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  // The gateway never forwards an API key; PostgREST derives the role from the
  // bearer token alone, and anonymous requests land on the `anon` role.
  headers.delete("apikey");

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
  });
  const out = new Headers(response.headers);
  out.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers: out });
}

const handler = {
  idleTimeout: 60,
  async fetch(request: Request, srv: { requestIP(r: Request): { address: string } | null }) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = srv.requestIP(request)?.address ?? "unknown";

    try {
      // ---- liveness / readiness (no auth; never returns secrets) ----------
      if (path === "/health" || path === "/ready") {
        const report = await collectHealth(sql, POSTGREST, appHost.state());
        const ok = report.components.every((c) => c.status === "ok" || c.status === "degraded");
        return json(report, path === "/ready" && !ok ? 503 : 200);
      }

      // ---- product / system information (versions only, never secrets) ----
      if (path === "/nova/v1/system" && request.method === "GET") {
        return json(await collectSystemInformation(sql, POSTGREST, appHost.state()));
      }

      // ---- local auth -----------------------------------------------------
      if (path === "/auth/v1/token" && request.method === "POST") {
        if (throttled(ip)) return json({ error: "Too many attempts, try again shortly" }, 429);
        const body = await readJson(request);
        const grant = url.searchParams.get("grant_type") ?? body["grant_type"] ?? "password";

        if (grant === "refresh_token") {
          return json(await refreshSession(authDeps, String(body["refresh_token"] ?? "")));
        }
        return json(
          await signInWithPassword(authDeps, {
            email: String(body["email"] ?? ""),
            password: String(body["password"] ?? ""),
            terminal: request.headers.get("x-nova-terminal") ?? undefined,
          }),
        );
      }

      if (path === "/auth/v1/logout" && request.method === "POST") {
        const body = await readJson(request);
        await signOut(authDeps, String(body["refresh_token"] ?? ""));
        return new Response(null, { status: 204 });
      }

      // ---- first-run provisioning ----------------------------------------
      if (path === "/nova/v1/bootstrap") {
        if (request.method === "GET") {
          const [row] = await sql`SELECT count(*)::int AS n FROM nova_local.bootstrap_events`;
          return json({ bootstrapped: (row?.n ?? 0) > 0 });
        }
        if (request.method === "POST") {
          if (throttled(ip, 5)) return json({ error: "Too many attempts" }, 429);
          return json(await bootstrapProperty(sql, await readJson(request)));
        }
      }

      // ---- data layer ------------------------------------------------------
      if (path.startsWith("/rest/v1/")) {
        return await proxyToPostgrest(request, path.replace("/rest/v1", ""));
      }

      if (path.startsWith("/auth/v1/") || path.startsWith("/nova/v1/")) {
        return json({ error: "Not found" }, 404);
      }

      // ---- application UI (React router stays authoritative) --------------
      return await appHost.serve(request);
    } catch (error) {
      if (error instanceof AuthError) return json({ error: error.message }, error.status);
      // Details go to the local log, never to the caller.
      console.error("[gateway]", error);
      return json({ error: "Internal error" }, 500);
    }
  },
};

const server = Bun.serve({
  hostname: HOST,
  port: tls.enabled ? tls.httpsPort : PORT,
  ...(tls.enabled
    ? { tls: { cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) } }
    : {}),
  ...handler,
});

// When TLS is on, the plain port exists only to send terminals to the secure
// origin — it never serves data.
if (tls.enabled) {
  Bun.serve({
    hostname: HOST,
    port: tls.httpPort,
    fetch(request) {
      const url = new URL(request.url);
      url.protocol = "https:";
      url.port = String(tls.httpsPort);
      return Response.redirect(url.toString(), 308);
    },
  });
}

console.log(
  `[nova-local] gateway listening on ${terminalOrigin(tls, HOST)} -> ${POSTGREST}` +
    (tls.enabled ? ` (HTTP :${tls.httpPort} redirects to HTTPS)` : ` (TLS off: ${tls.reason})`),
);