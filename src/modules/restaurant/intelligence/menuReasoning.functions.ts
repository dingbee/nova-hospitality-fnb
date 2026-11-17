import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runMenuIntelligenceReasoningSchema } from "./menuReasoning.contracts";

export const runMenuIntelligenceReasoningFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => runMenuIntelligenceReasoningSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./menuReasoning.server");
    return mod.runMenuIntelligenceReasoning(context.supabase, context.userId, data);
  });
