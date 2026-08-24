import { createServerFn } from "@tanstack/react-start";
import { guestMenuSchema, submitGuestOrderSchema } from "./selforder.contracts";

/**
 * No requireSupabaseAuth here — a customer scanning a table has no staff
 * session to present. Each handler loads its own service-role client
 * (never top-level: this file ships to the client bundle, see
 * client.server.ts) and hands it to selforder.server.ts, which re-derives
 * tenant/property/location/price/station from the table id itself. See
 * src/lib/rbac/authorization-gate.test.ts for the source-level checks that
 * hold this file to the same discipline as the guest-receipt surface.
 */
export const guestMenuFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => guestMenuSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selforder.server");
    return mod.guestMenu(supabaseAdmin, data.tableId);
  });

export const submitGuestOrderFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => submitGuestOrderSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selforder.server");
    return mod.submitGuestOrder(supabaseAdmin, data);
  });
