import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { confirmGoLiveSchema, getReadinessReportSchema } from "./contracts";

export const getReadinessReportFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getReadinessReportSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./readiness.server");
    return mod.computeReadiness(context.supabase, context.userId, data.tenantId);
  });

export const confirmGoLiveFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => confirmGoLiveSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./readiness.server");
    return mod.confirmGoLive(context.supabase, context.userId, data.tenantId);
  });
