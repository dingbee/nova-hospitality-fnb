import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  executeRestaurantActionSchema,
  orchestrateApprovedRestaurantActionsSchema,
  restaurantDecisionBoardSchema,
  runRestaurantDecisionPassSchema,
  verifyRestaurantActionSchema,
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

/**
 * The separate, subsequent confirmation step (P10): re-reads the real
 * procurement request an executed action was supposed to produce and
 * reports "verified" or "verification_failed" — never inferred from the
 * executor's own cached result. I5 wires this into the Decisions page so a
 * human can see the third step of "Replenishment recommended → Draft
 * created → Verified", not just the first two.
 */
export const verifyRestaurantActionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => verifyRestaurantActionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./actions.server");
    return mod.verifyRestaurantAction(context.supabase, context.userId, data);
  });

/**
 * I11 — discovers this tenant's currently-approved restaurant actions from
 * the database (never from anything the client supplies) and runs each one
 * through the existing executeRestaurantActionFn logic above. A human still
 * had to approve every action beforehand via decideDecision; this only
 * closes the "who finds the approved ones" gap the per-row Execute button
 * left open. Never calls verifyRestaurantAction — Act and Verify remain
 * separate operations.
 */
export const orchestrateApprovedRestaurantActionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => orchestrateApprovedRestaurantActionsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./actions.server");
    return mod.orchestrateApprovedRestaurantActions(context.supabase, context.userId, data);
  });
