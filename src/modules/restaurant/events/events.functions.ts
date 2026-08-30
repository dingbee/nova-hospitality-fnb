import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { restaurantEventSchema } from "./contracts";
import { consumeRestaurantEventsSchema } from "./consume.server";

export const emitRestaurantEventFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => restaurantEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    const guards = await import("../core/access.server");
    await guards.assertTenantRead(context.supabase, context.userId, data.tenantId);
    const mod = await import("./emit.server");
    return mod.emitRestaurantEvent(context.supabase, context.userId, data);
  });

/**
 * I9 — the first Intelligence event consumer, wired into the request path
 * the Decisions page's own "Run decision pass" button already uses. See
 * consume.server.ts for what it does and does not do.
 */
export const consumeRestaurantEventsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => consumeRestaurantEventsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./consume.server");
    return mod.consumeRestaurantEvents(context.supabase, context.userId, data);
  });
