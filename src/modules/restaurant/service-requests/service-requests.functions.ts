import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  acknowledgeServiceRequestSchema,
  resolveServiceRequestSchema,
} from "./service-requests.contracts";

export const acknowledgeServiceRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => acknowledgeServiceRequestSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./service-requests.server");
    return mod.acknowledgeServiceRequest(context.supabase, context.userId, data);
  });

export const resolveServiceRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => resolveServiceRequestSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./service-requests.server");
    return mod.resolveServiceRequest(context.supabase, context.userId, data);
  });
