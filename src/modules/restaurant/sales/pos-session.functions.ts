import { createServerFn } from "@tanstack/react-start";
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
    return mod.startPosSession(context.supabase, context.authenticatedUserId, data);
  });

export const endPosSessionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuthForGateway])
  .inputValidator((d: unknown) => endPosSessionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos-session.server");
    return mod.endPosSession(context.supabase, context.authenticatedUserId, data.sessionId);
  });
