import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const resetDemoEnvironmentSchema = z.object({ dryRun: z.boolean().default(true) });

/** Commercial-admin only (checked inside resetDemoEnvironment, and again at the SQL level). Never public. */
export const resetDemoEnvironmentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => resetDemoEnvironmentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reset.server");
    return mod.resetDemoEnvironment(context.supabase, context.userId, data.dryRun);
  });
