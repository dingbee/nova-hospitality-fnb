import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { businessContextSchema } from "./context.types";

export const getBusinessContextFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => businessContextSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./context.server");
    return mod.getBusinessContext(context.supabase, context.userId, data);
  });
