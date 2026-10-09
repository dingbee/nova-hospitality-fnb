import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { serviceRecoverySchema } from "./service-recovery.contracts";

export const recordServiceRecoveryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => serviceRecoverySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./service-recovery.server");
    return mod.recordServiceRecovery(context.supabase, context.userId, data);
  });
