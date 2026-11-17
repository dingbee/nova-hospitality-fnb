import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { listProfitabilitySchema, profitabilitySchema } from "../core/contracts";

export const computeRestaurantProfitabilityFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => profitabilitySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./profitability.server");
    return mod.computeProfitability(context.supabase, context.userId, data);
  });

export const listRestaurantProfitabilityFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listProfitabilitySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./profitability.server");
    return mod.listProfitability(context.supabase, context.userId, data);
  });
