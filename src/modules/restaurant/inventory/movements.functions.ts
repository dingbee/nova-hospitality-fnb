import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { listMovementsSchema, recordMovementSchema, transferStockSchema } from "../core/contracts";

export const listRestaurantStockMovementsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listMovementsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./movements.server");
    return mod.listMovements(context.supabase, context.userId, data);
  });

export const recordRestaurantStockMovementFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordMovementSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./movements.server");
    return mod.recordMovement(context.supabase, context.userId, data);
  });

export const transferRestaurantStockFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => transferStockSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./movements.server");
    return mod.transferStock(context.supabase, context.userId, data);
  });
