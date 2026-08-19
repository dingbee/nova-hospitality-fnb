import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  captureStatementSchema,
  guestContextSchema,
  recordGuestContextSchema,
} from "./guest-context.contracts";

export const getGuestServiceContextFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => guestContextSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./guest-context.server");
    return mod.getGuestServiceContext(context.supabase, context.userId, data);
  });

export const screenMenuForGuestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => guestContextSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./guest-context.server");
    return mod.screenMenuForGuest(context.supabase, context.userId, data);
  });

export const recordGuestContextFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordGuestContextSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./guest-context.server");
    return mod.recordGuestContext(context.supabase, context.userId, data);
  });

export const captureGuestStatementFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => captureStatementSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./guest-context.server");
    return mod.captureGuestStatement(context.supabase, context.userId, data);
  });

export const listGuestContextFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ tenantId: z.string().uuid(), limit: z.number().int().min(1).max(300).default(100) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./guest-context.server");
    return mod.listGuestContextForTenant(context.supabase, context.userId, data.tenantId, data.limit);
  });