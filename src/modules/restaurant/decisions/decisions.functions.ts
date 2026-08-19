import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { restaurantDecisionBoardSchema, runRestaurantDecisionPassSchema } from "./decision.types";

export const getRestaurantDecisionBoardFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => restaurantDecisionBoardSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./decisions.server");
    return mod.getRestaurantDecisionBoard(context.supabase, context.userId, data);
  });

export const runRestaurantDecisionPassFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => runRestaurantDecisionPassSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./decisions.server");
    return mod.runRestaurantDecisionPass(context.supabase, context.userId, data);
  });