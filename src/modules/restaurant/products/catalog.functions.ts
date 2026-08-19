/**
 * Product, Recipe & Production RPC surface (Sprint 5.3).
 *
 * Thin wrappers only. Every handler validates with a Zod contract and defers to
 * a server-only service where the tenant and capability guards live.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  attachModifierGroupSchema,
  cancelProductionSchema,
  completeProductionSchema,
  computeRecipeCostSchema,
  listModifiersSchema,
  listProductionsSchema,
  listProductsSchema,
  listRecipesSchema,
  productIdSchema,
  productionIdSchema,
  recipeIdSchema,
  setRecipeStatusSchema,
  startProductionSchema,
  upsertBundleComponentSchema,
  upsertModifierGroupSchema,
  upsertModifierSchema,
  upsertProductSchema,
  upsertRecipeSchema,
  upsertVariantSchema,
  versionRecipeSchema,
} from "./contracts";

/* ---------------- Recipes ---------------- */

export const listRestaurantRecipesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listRecipesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./recipes.server");
    return mod.listRecipes(context.supabase, context.userId, data);
  });

export const getRestaurantRecipeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recipeIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./recipes.server");
    return mod.getRecipe(context.supabase, context.userId, data.tenantId, data.recipeId);
  });

export const upsertRestaurantRecipeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertRecipeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./recipes.server");
    return mod.upsertRecipe(context.supabase, context.userId, data);
  });

export const versionRestaurantRecipeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => versionRecipeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./recipes.server");
    return mod.versionRecipe(context.supabase, context.userId, data);
  });

export const setRestaurantRecipeStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setRecipeStatusSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./recipes.server");
    return mod.setRecipeStatus(context.supabase, context.userId, data);
  });

export const computeRestaurantRecipeCostV2Fn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => computeRecipeCostSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./recipes.server");
    return mod.computeRecipeCost(context.supabase, context.userId, data);
  });

/* ---------------- Products ---------------- */

export const listRestaurantProductsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listProductsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./products.server");
    return mod.listProducts(context.supabase, context.userId, data);
  });

export const getRestaurantProductFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => productIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./products.server");
    return mod.getProduct(context.supabase, context.userId, data.tenantId, data.productId);
  });

export const upsertRestaurantProductFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertProductSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./products.server");
    return mod.upsertProduct(context.supabase, context.userId, data);
  });

export const upsertRestaurantVariantFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertVariantSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./products.server");
    return mod.upsertVariant(context.supabase, context.userId, data);
  });

export const listRestaurantModifierGroupsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listModifiersSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./products.server");
    return mod.listModifierGroups(context.supabase, context.userId, data);
  });

export const upsertRestaurantModifierGroupFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertModifierGroupSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./products.server");
    return mod.upsertModifierGroup(context.supabase, context.userId, data);
  });

export const upsertRestaurantModifierFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertModifierSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./products.server");
    return mod.upsertModifier(context.supabase, context.userId, data);
  });

export const attachRestaurantModifierGroupFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => attachModifierGroupSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./products.server");
    return mod.attachModifierGroup(context.supabase, context.userId, data);
  });

export const upsertRestaurantBundleComponentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertBundleComponentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./products.server");
    return mod.upsertBundleComponent(context.supabase, context.userId, data);
  });

/* ---------------- Production ---------------- */

export const listRestaurantProductionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listProductionsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./production.server");
    return mod.listProductions(context.supabase, context.userId, data);
  });

export const getRestaurantProductionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => productionIdSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./production.server");
    return mod.getProduction(context.supabase, context.userId, data.tenantId, data.productionId);
  });

export const startRestaurantProductionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => startProductionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./production.server");
    return mod.startProduction(context.supabase, context.userId, data);
  });

export const completeRestaurantProductionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => completeProductionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./production.server");
    return mod.completeProduction(context.supabase, context.userId, data);
  });

export const cancelRestaurantProductionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelProductionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./production.server");
    return mod.cancelProduction(context.supabase, context.userId, data);
  });

/* ---------------- Intelligence evidence ---------------- */

export const getRestaurantProductEvidenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./evidence.server");
    return mod.getProductEvidence(context.supabase, context.userId, data.tenantId);
  });
