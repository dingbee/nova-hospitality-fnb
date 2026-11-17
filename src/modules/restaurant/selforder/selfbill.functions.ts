import { createServerFn } from "@tanstack/react-start";
import { requestGuestBillSchema } from "./selfbill.contracts";

/**
 * No requireSupabaseAuth — same reasoning as selforder.functions.ts and
 * selfpay.functions.ts. Scoped by tableId + orderId (both unguessable
 * uuids), never by identity. See
 * src/lib/rbac/authorization-gate.test.ts for the source-level checks
 * that hold this file to the same discipline as the rest of the guest
 * surface.
 */
export const requestGuestBillFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => requestGuestBillSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfbill.server");
    return mod.requestGuestBill(supabaseAdmin, data);
  });
