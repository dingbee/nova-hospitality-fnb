import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { roomChargeCommitSchema, roomChargeQuoteSchema, roomChargeSearchSchema } from "./roomcharge.contracts";

export const searchRoomChargeTargetsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => roomChargeSearchSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./roomcharge.server");
    return mod.searchRoomChargeTargets(context.supabase, context.userId, data);
  });

export const quoteRoomChargeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => roomChargeQuoteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./roomcharge.server");
    return mod.quoteRoomCharge(context.supabase, context.userId, data);
  });

export const commitRoomChargeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => roomChargeCommitSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./roomcharge.server");
    return mod.commitRoomCharge(context.supabase, context.userId, data);
  });
