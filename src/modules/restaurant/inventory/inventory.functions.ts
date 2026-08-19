import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { listInventorySchema, upsertInventoryItemSchema } from "../core/contracts";

export const listRestaurantInventoryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listInventorySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./inventory.server");
    return mod.listInventory(context.supabase, context.userId, data);
  });

export const listRestaurantUnitsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./inventory.server");
    return mod.listUnits(context.supabase, context.userId, data.tenantId);
  });

export const upsertRestaurantInventoryItemFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertInventoryItemSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./inventory.server");
    return mod.upsertInventoryItem(context.supabase, context.userId, data);
  });