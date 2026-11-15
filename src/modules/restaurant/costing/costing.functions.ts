import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { computeRecipeCostSchema, recipeSchema, upsertRecipeComponentSchema } from "../core/contracts";

export const listRestaurantRecipeComponentsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recipeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.listRecipeComponents(context.supabase, context.userId, data);
  });

export const upsertRestaurantRecipeComponentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertRecipeComponentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.upsertRecipeComponent(context.supabase, context.userId, data);
  });

export const computeRestaurantRecipeCostFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => computeRecipeCostSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.computeRecipeCost(context.supabase, context.userId, data);
  });

export const listRestaurantRecipeCostsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.listRecipeCosts(context.supabase, context.userId, data.tenantId);
  });

const activityDriverSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  periodStart: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
  units: z.number().positive().finite(),
});

export const upsertRestaurantCostActivityDriverFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => activityDriverSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.upsertCostActivityDriver(context.supabase, context.userId, data);
  });

export const listRestaurantCostActivityDriversFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    tenantId: z.string().uuid(),
    driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    periodStart: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
    propertyId: z.string().uuid().optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.listCostActivityDrivers(context.supabase, context.userId, data);
  });

export const commitRestaurantConsumptionAllocationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    tenantId: z.string().uuid(),
    movementId: z.string().uuid(),
    driverKey: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
    unallocatedReason: z.string().trim().min(3).max(500).optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./costing.server");
    return mod.commitConsumptionAllocation(context.supabase, context.userId, data);
  });
