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
    try {
      const mod = await import("./staffnova.server");
      return await mod.askStaffNova(context.supabase, context.userId, data);
    } catch (error) {
      // The Staff Ask LexiBite UI expects a serializable answer. Any failure
      // after authentication/validation must therefore degrade at this
      // boundary instead of rejecting the RPC and forcing the UI into its
      // transport-error state. Keep the real exception server-side so the
      // failing pre-provider stage can be diagnosed from deployment logs.
      console.error("[StaffNova] request boundary failure", {
        tenantId: data.tenantId,
        userId: context.userId,
        error,
      });

      return {
        answer:
          "I'm unable to process that request right now. Please try again in a moment.",
        degraded: true,
        generatedAt: new Date().toISOString(),
      };
    }
  });
