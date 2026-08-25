import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  executeRestaurantActionSchema,
  restaurantDecisionBoardSchema,
  runRestaurantDecisionPassSchema,
} from "./decision.types";

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

/**
 * Runs the one existing Act-stage executor against an already-approved
 * action. It creates (or, on retry, recovers) a draft in the existing
 * restaurant_purchase_requests workflow — never a purchase order, never a
 * supplier contact — and always leaves it awaiting its own separate human
 * submission and approval.
 */
export const executeRestaurantActionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => executeRestaurantActionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./actions.server");
    return mod.executeRestaurantAction(context.supabase, context.userId, data);
  });
