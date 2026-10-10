import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, setCookie } from "@tanstack/react-start/server";
import {
  requireSupabaseAuth,
  requireSupabaseAuthForGateway,
} from "@/integrations/supabase/auth-middleware";
import {
  setPosPinSchema,
  clearPosPinSchema,
  startPosSessionSchema,
  endPosSessionSchema,
} from "./pos-session.contracts";

const STAFF_TOKEN_COOKIE = "lexibite_staff_token";
const STAFF_COOKIE_OPTIONS = {
  path: "/",
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
};

export const setPosPinFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setPosPinSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos-session.server");
    return mod.setPosPin(context.supabase, context.userId, data);
  });

export const clearPosPinFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => clearPosPinSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos-session.server");
    return mod.clearPosPin(context.supabase, context.userId, data);
  });

// Only these session lifecycle calls may run before the PIN gateway is unlocked.
export const startPosSessionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuthForGateway])
  .inputValidator((d: unknown) => startPosSessionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos-session.server");
    const session = await mod.startPosSession(context.supabase, context.authenticatedUserId, data);
    const { sessionToken, ...safeSession } = session as Record<string, unknown> & { sessionToken?: string };
    if (!sessionToken || typeof sessionToken !== "string") {
      throw new Error("PIN session proof was not returned. Try again.");
    }
    setCookie(STAFF_TOKEN_COOKIE, sessionToken, {
      ...STAFF_COOKIE_OPTIONS,
      httpOnly: true,
      maxAge: 12 * 60 * 60,
    });
    return safeSession;
  });

export const endPosSessionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuthForGateway])
  .inputValidator((d: unknown) => endPosSessionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos-session.server");
    const result = await mod.endPosSession(context.supabase, context.authenticatedUserId, data.sessionId);
    deleteCookie(STAFF_TOKEN_COOKIE, STAFF_COOKIE_OPTIONS);
    return result;
  });

// Clear stale HttpOnly proof when switching back to owner mode or signing out,
// including when the session is already expired or no longer visible in bootstrap.
export const clearStaffTokenCookieFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuthForGateway])
  .handler(() => {
    deleteCookie(STAFF_TOKEN_COOKIE, STAFF_COOKIE_OPTIONS);
    return { ok: true };
  });
