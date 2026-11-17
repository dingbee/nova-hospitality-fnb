import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { roomChargeCommitSchema, roomChargeQuoteSchema, roomChargeSearchSchema, roomChargeReversalSchema, roomChargeReversalFinalizeSchema } from "./roomcharge.contracts";

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

export const requestRoomChargeReversalFn=createServerFn({method:"POST"})
 .middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>roomChargeReversalSchema.parse(d))
 .handler(async({data,context})=>{
  const mod=await import("./roomcharge.server");
  return mod.requestRoomChargeReversal(context.supabase,context.userId,data);
 });

export const finalizeRoomChargeReversalFn=createServerFn({method:"POST"})
 .middleware([requireSupabaseAuth])
 .inputValidator((d:unknown)=>roomChargeReversalFinalizeSchema.parse(d))
 .handler(async({data,context})=>{
  const mod=await import("./roomcharge.server");
  return mod.finalizeRoomChargeReversal(context.supabase,context.userId,data);
 });
