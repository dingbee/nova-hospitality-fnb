import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { serviceRecoverySchema } from "./service-recovery.contracts";
import { z } from "zod";

const listCasesSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const listServiceRecoveryCasesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCasesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./service-recovery.server");
    return mod.listServiceRecoveryCases(context.supabase, context.userId, data);
  });

export const recordServiceRecoveryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => serviceRecoverySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./service-recovery.server");
    return mod.recordServiceRecovery(context.supabase, context.userId, data);
  });
