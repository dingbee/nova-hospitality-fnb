import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { staffNovaAskSchema } from "./staffnova.contracts";

/**
 * Staff Ask NOVA — authenticated, unlike guest Ask NOVA's askNovaFn
 * (selfnova.functions.ts). Not added to authorization-gate.test.ts's
 * ALLOWED_UNAUTHENTICATED list: requireSupabaseAuth here is exactly the
 * same middleware every other staff-facing server function in this app
 * uses, and askStaffNova re-derives tenant/capability authorization from
 * the verified JWT userId — the client-supplied tenantId is never trusted
 * on its own.
 */
export const askStaffNovaFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => staffNovaAskSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./staffnova.server");
    return mod.askStaffNova(context.supabase, context.userId, data);
  });
