import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  decideDecisionSchema,
  decisionBoardSchema,
  runDecisionPassSchema,
  updatePlanStepSchema,
} from "./decision.types";

export const getDecisionBoardFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => decisionBoardSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./decision.server");
    return mod.getDecisionBoard(context.supabase, context.userId, data);
  });

export const runDecisionPassFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => runDecisionPassSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./decision.server");
    return mod.runDecisionPass(context.supabase, context.userId, data);
  });

export const decideDecisionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => decideDecisionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./decision.server");
    return mod.decideDecision(context.supabase, context.userId, data);
  });

export const updatePlanStepFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updatePlanStepSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./decision.server");
    return mod.updatePlanStep(context.supabase, context.userId, data);
  });