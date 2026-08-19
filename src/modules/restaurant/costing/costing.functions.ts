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