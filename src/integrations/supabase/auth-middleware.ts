// NOVA Hospitality F&B — authenticated request context with PIN-gated staff actor resolution.
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { logServerDenial, logServerFailure } from "@/lib/observability/log.server";

export const STAFF_SESSION_COOKIE = "lexibite_staff_session";

export type StaffSessionContext = {
  sessionId: string;
  tenantId: string;
  propertyId: string;
  staffUserId: string;
  staffMemberId: string;
  role: string;
  terminalId: string;
  expiresAt: string;
};

type StaffAccessBootstrap = {
  platformAdmin?: boolean;
  owner?: boolean;
  hasRestaurantMembership?: boolean;
  canActivate?: boolean;
  activeSession?: StaffSessionContext | null;
};

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

async function authenticateRequest(requestId: string | null) {
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

  const token = authHeader.slice("Bearer ".length);
  if (!token) {
    logServerDenial("auth", requestId, { reason: "empty_bearer_token" });
    throw new Error("Unauthorized: No token provided");
  }

  const staffSessionToken = cookieValue(request.headers.get("cookie"), "lexibite_staff_token");
  const requestHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (staffSessionToken) requestHeaders["x-lexibite-staff-session"] = staffSessionToken;

  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: requestHeaders },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims) {
    if (error) {
      logServerFailure("auth", requestId, { reason: "token_verification_failed" }, error);
    } else {
      logServerDenial("auth", requestId, { reason: "token_verified_no_claims" });
    }
    throw new Error("Unauthorized: Invalid token");
  }
  const authenticatedUserId = data.claims.sub;
  if (!authenticatedUserId) {
    logServerDenial("auth", requestId, { reason: "token_missing_subject" });
    throw new Error("Unauthorized: No user ID found in token");
  }

  return {
    supabase,
    authenticatedUserId,
    claims: data.claims,
    request,
  };
}

/**
 * Full application middleware. Restaurant members must have a valid manager-authorised
 * PIN session before any protected server function can run. The SQL RLS predicates
 * independently resolve the same staff_member_id, so a browser-held manager JWT does
 * not retain manager permissions while a staff PIN session is active.
 */
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next, context }) => {
    const requestId = (context as { requestId?: string } | undefined)?.requestId ?? null;
    const auth = await authenticateRequest(requestId);
    const { data, error } = await (auth.supabase as any).rpc("restaurant_staff_access_bootstrap");

    if (error || !data) {
      logServerFailure("auth", requestId, { reason: "staff_access_context_unavailable" }, error);
      throw new Error("Access could not be verified. Refresh and try again.");
    }

    const access = data as StaffAccessBootstrap;
    const cookieSessionId = cookieValue(auth.request.headers.get("cookie"), STAFF_SESSION_COOKIE);
    const staffTokenCookie = cookieValue(auth.request.headers.get("cookie"), "lexibite_staff_token");
    const staffModeRequested = Boolean(cookieSessionId || staffTokenCookie);
    if ((access.platformAdmin || access.owner || !access.hasRestaurantMembership) && !staffModeRequested) {
      return next({
        context: {
          supabase: auth.supabase,
          userId: auth.authenticatedUserId,
          authenticatedUserId: auth.authenticatedUserId,
          claims: auth.claims,
          staffSession: null,
          platformAdmin: Boolean(access.platformAdmin),
          tenantOwner: Boolean(access.owner),
        },
      });
    }

    const session = access.activeSession;
    if (
      !access.canActivate ||
      !session ||
      !cookieSessionId ||
      cookieSessionId !== session.sessionId
    ) {
      logServerDenial("auth", requestId, {
        reason: "staff_access_gateway_locked",
        userId: auth.authenticatedUserId,
      });
      throw new Error("Staff Access Gateway is locked. Enter an authorised PIN to continue.");
    }

    return next({
      context: {
        supabase: auth.supabase,
        userId: session.staffUserId,
        authenticatedUserId: auth.authenticatedUserId,
        claims: auth.claims,
        staffSession: session,
        platformAdmin: false,
        tenantOwner: false,
      },
    });
  },
);

/**
 * Narrow middleware for the bootstrap/PIN start/end endpoints only. It authenticates
 * the manager account but deliberately does not grant an operational actor. Every
 * other server function uses requireSupabaseAuth above.
 */
export const requireSupabaseAuthForGateway = createMiddleware({ type: "function" }).server(
  async ({ next, context }) => {
    const requestId = (context as { requestId?: string } | undefined)?.requestId ?? null;
    const auth = await authenticateRequest(requestId);
    return next({
      context: {
        supabase: auth.supabase,
        userId: auth.authenticatedUserId,
        authenticatedUserId: auth.authenticatedUserId,
        claims: auth.claims,
        staffSession: null,
        platformAdmin: false,
        tenantOwner: false,
      },
    });
  },
);
