import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { understandNovaInstructionSchema } from "./intent.contracts";

/**
 * I11 — authenticated staff-only understanding endpoint. Re-derives
 * tenant/capability authorization from the verified JWT userId exactly
 * like askStaffNovaFn does; the client-supplied tenantId is never trusted
 * on its own. Understanding only — see understand.server.ts.
 */
export const understandNovaInstructionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => understandNovaInstructionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./understand.server");
    return mod.understandNovaInstruction(context.supabase, context.userId, data);
  });
