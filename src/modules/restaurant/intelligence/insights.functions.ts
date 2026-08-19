import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { intelligenceWindowSchema } from "./types";

export const getRestaurantMenuIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => intelligenceWindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./menu.server");
    return mod.getMenuIntelligence(context.supabase, context.userId, data);
  });

export const getRestaurantInventoryIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => intelligenceWindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./inventory.server");
    return mod.getInventoryIntelligence(context.supabase, context.userId, data);
  });

export const getRestaurantKitchenIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => intelligenceWindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./kitchen.server");
    return mod.getKitchenIntelligence(context.supabase, context.userId, data);
  });

export const getRestaurantPurchasingIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => intelligenceWindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./purchasing.server");
    return mod.getPurchasingIntelligence(context.supabase, context.userId, data);
  });