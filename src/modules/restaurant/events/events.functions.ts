import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { restaurantEventSchema } from "./contracts";

export const emitRestaurantEventFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => restaurantEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    const guards = await import("../core/access.server");
    await guards.assertTenantRead(context.supabase, context.userId, data.tenantId);
    const mod = await import("./emit.server");
    return mod.emitRestaurantEvent(context.supabase, context.userId, data);
  });