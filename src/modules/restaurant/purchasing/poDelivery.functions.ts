/** Purchase-order supplier-communication RPC surface. Thin wrappers only. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { listPoDeliveriesSchema, requestPoDeliverySchema } from "./poDelivery.types";

export const requestPoDeliveryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => requestPoDeliverySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./poDelivery.server");
    return mod.requestPoDelivery(context.supabase, context.userId, data);
  });

export const listPoDeliveriesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listPoDeliveriesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./poDelivery.server");
    return mod.listPoDeliveries(context.supabase, context.userId, data);
  });

export const poDeliveryProvidersFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const mod = await import("./poDelivery.server");
    return mod.providerStatus();
  });
