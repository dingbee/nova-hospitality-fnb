import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { p05WindowSchema } from "./p05.types";

export const getStayNasIntegrationIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => p05WindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./staynas.server");
    return mod.getStayNasIntegrationIntelligence(context.supabase, context.userId, data);
  });
