import { createServerFn } from "@tanstack/react-start";
import { guestSessionProjectionSchema } from "./selfsession.contracts";

/**
 * No requireSupabaseAuth — same reasoning as every other guest-facing
 * function in this module (see selftrack.functions.ts). Scoped by tableId
 * (an unguessable uuid) only; the server derives the active session and its
 * orders from that table, never from anything the client asserts.
 */
export const guestSessionProjectionFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => guestSessionProjectionSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfsession.server");
    return mod.guestSessionProjection(supabaseAdmin, data);
  });
