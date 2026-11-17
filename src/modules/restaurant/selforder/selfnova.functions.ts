import { createServerFn } from "@tanstack/react-start";
import { askNovaSchema } from "./selfnova.contracts";

/**
 * No requireSupabaseAuth — same reasoning as every other guest-facing
 * function in this module. Scoped by tableId only (an unguessable uuid),
 * never by identity. See src/lib/rbac/authorization-gate.test.ts for the
 * source-level checks that hold this file to the same discipline as the
 * rest of the guest surface.
 */
export const askNovaFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => askNovaSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfnova.server");
    return mod.askNova(supabaseAdmin, data);
  });
