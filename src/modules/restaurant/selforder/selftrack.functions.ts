import { createServerFn } from "@tanstack/react-start";
import { guestOrderProgressSchema } from "./selftrack.contracts";

/**
 * No requireSupabaseAuth — same reasoning as every other guest-facing
 * function in this module. Scoped by tableId + orderId (both unguessable
 * uuids), never by identity. See src/lib/rbac/authorization-gate.test.ts
 * for the source-level checks that hold this file to the same discipline
 * as the rest of the guest surface.
 */
export const guestOrderProgressFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => guestOrderProgressSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selftrack.server");
    return mod.guestOrderProgress(supabaseAdmin, data);
  });
