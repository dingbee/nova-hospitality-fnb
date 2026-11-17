import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { guestFeedbackSummarySchema } from "./feedback.contracts";

export const getGuestFeedbackSummaryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => guestFeedbackSummarySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./feedback.server");
    return mod.getGuestFeedbackSummary(context.supabase, context.userId, data);
  });
