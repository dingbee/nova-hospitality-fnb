// NOVA Hospitality F&B — data-API client (product-owned).
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { logServerDenial, logServerFailure } from "@/lib/observability/log.server";

// ME-16 remediation (ME16-05): every denial branch below now logs enough to
// answer "who was refused, when, and why" without ever logging the
// presented token/credential itself. `requestId` comes from the global
// server-fn correlation middleware (src/lib/observability/server-fn-correlation.ts),
// registered ahead of this middleware in src/start.ts's functionMiddleware
// array, so it is already present on `context` by the time this runs.
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next, context }) => {
    const requestId = (context as { requestId?: string } | undefined)?.requestId ?? null;

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      const missing = [
        ...(!SUPABASE_URL ? ["SUPABASE_URL"] : []),
        ...(!SUPABASE_PUBLISHABLE_KEY ? ["SUPABASE_PUBLISHABLE_KEY"] : []),
      ];
      const message = `Missing Supabase environment variable(s): ${missing.join(", ")}. Configure the appliance environment (standalone/.env).`;
      console.error(`[Supabase] ${message}`);
      throw new Error(message);
    }

    const request = getRequest();

    if (!request?.headers) {
      logServerDenial("auth", requestId, { reason: "no_request_headers" });
      throw new Error("Unauthorized: No request headers available");
    }

    const authHeader = request.headers.get("authorization");

    if (!authHeader) {
      logServerDenial("auth", requestId, { reason: "missing_authorization_header" });
      throw new Error("Unauthorized: No authorization header provided");
    }

    if (!authHeader.startsWith("Bearer ")) {
      logServerDenial("auth", requestId, { reason: "unsupported_auth_scheme" });
      throw new Error("Unauthorized: Only Bearer tokens are supported");
    }

    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      logServerDenial("auth", requestId, { reason: "empty_bearer_token" });
      throw new Error("Unauthorized: No token provided");
    }

    const supabase = createClient<Database>(SUPABASE_URL!, SUPABASE_PUBLISHABLE_KEY!, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      auth: {
        storage: undefined,
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims) {
      if (error) {
        // A verification failure (expired/malformed/revoked token) is
        // distinct from "no token presented" — log the classification
        // Supabase itself returned, never the token.
        logServerFailure("auth", requestId, { reason: "token_verification_failed" }, error);
      } else {
        logServerDenial("auth", requestId, { reason: "token_verified_no_claims" });
      }
      throw new Error("Unauthorized: Invalid token");
    }

    if (!data.claims.sub) {
      logServerDenial("auth", requestId, { reason: "token_missing_subject" });
      throw new Error("Unauthorized: No user ID found in token");
    }

    return next({
      context: {
        supabase,
        userId: data.claims.sub,
        claims: data.claims,
      },
    });
  },
);
