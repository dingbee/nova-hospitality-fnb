import { createServerFn } from "@tanstack/react-start";
import { guestOrderStatusSchema, initiateGuestPaymentSchema } from "./selfpay.contracts";

/**
 * No requireSupabaseAuth — same reasoning as selforder.functions.ts. Scoped
 * by tableId + orderId (both unguessable uuids), never by identity. See
 * src/lib/rbac/authorization-gate.test.ts for the source-level checks that
 * hold this file to the same discipline as the rest of the guest surface.
 */
export const guestOrderStatusFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => guestOrderStatusSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfpay.server");
    return mod.guestOrderStatus(supabaseAdmin, data);
  });

export const initiateGuestPaymentFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => initiateGuestPaymentSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfpay.server");
    return mod.initiateGuestPayment(supabaseAdmin, data);
  });
