import { createServerFn } from "@tanstack/react-start";
import { requestStaffSchema } from "./selfstaff.contracts";

/**
 * No requireSupabaseAuth — same reasoning as every other guest-facing
 * function in this module. Scoped by tableId + orderId (both unguessable
 * uuids), never by identity. See src/lib/rbac/authorization-gate.test.ts
 * for the source-level checks that hold this file to the same discipline
 * as the rest of the guest surface.
 */
export const requestStaffFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => requestStaffSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfstaff.server");
    return mod.requestStaff(supabaseAdmin, data);
  });

export const guestStaffRequestStatusFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => requestStaffSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfstaff.server");
    return mod.guestStaffRequestStatus(supabaseAdmin, data);
  });
