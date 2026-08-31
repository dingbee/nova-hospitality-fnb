import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  executeNovaPreparationSchema,
  previewNovaExecutionSchema,
  verifyNovaExecutionSchema,
} from "./act.contracts";

/** Read-only — see act.server.ts. Re-derives tenant/capability authorization from the verified JWT userId, never the client-supplied tenantId alone. */
export const previewNovaExecutionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => previewNovaExecutionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./act.server");
    return mod.previewNovaExecution(context.supabase, context.userId, data);
  });

/** The only I13 entry point that can write anything — only ever called from an explicit human "Execute" click, never automatically, never chained off a chat message alone. */
export const executeNovaPreparationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => executeNovaPreparationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./act.server");
    return mod.executeNovaPreparation(context.supabase, context.userId, data);
  });

/** Independent verification, callable standalone at any time after execution — never auto-chained. */
export const verifyNovaExecutionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => verifyNovaExecutionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./act.server");
    return mod.verifyNovaExecution(context.supabase, context.userId, data);
  });
