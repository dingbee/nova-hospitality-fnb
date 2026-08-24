import { createServerFn } from "@tanstack/react-start";
import { guestFeedbackStatusSchema, submitGuestFeedbackSchema } from "./selffeedback.contracts";

/**
 * No requireSupabaseAuth — same reasoning as every other guest-facing
 * function in this module. Scoped by tableId + orderId (both unguessable
 * uuids), never by identity. See src/lib/rbac/authorization-gate.test.ts
 * for the source-level checks that hold this file to the same discipline
 * as the rest of the guest surface.
 */
export const guestFeedbackStatusFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => guestFeedbackStatusSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selffeedback.server");
    return mod.guestFeedbackStatus(supabaseAdmin, data);
  });

export const submitGuestFeedbackFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => submitGuestFeedbackSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selffeedback.server");
    return mod.submitGuestFeedback(supabaseAdmin, data);
  });
