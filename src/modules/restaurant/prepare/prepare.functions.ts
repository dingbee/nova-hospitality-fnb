import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { commitNovaPreparationSchema, previewNovaPreparationSchema } from "./prepare.contracts";

/** Read-only — see prepare.server.ts. Re-derives tenant/capability authorization from the verified JWT userId, never the client-supplied tenantId alone. */
export const previewNovaPreparationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => previewNovaPreparationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./prepare.server");
    return mod.previewNovaPreparation(context.supabase, context.userId, data);
  });

/** The only I12 entry point that can write anything — only ever called from an explicit human button click, never automatically. */
export const commitNovaPreparationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => commitNovaPreparationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./prepare.server");
    return mod.commitNovaPreparation(context.supabase, context.userId, data);
  });
