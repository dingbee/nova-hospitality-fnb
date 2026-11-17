import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const tenantOnly = z.object({ tenantId: z.string().uuid() });

export const importRecipeMasterFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({ propertyId: z.string().uuid().nullish(), dryRun: z.boolean().optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./recipe-import.server");
    return mod.importRecipeMaster(context.supabase, context.userId, data);
  });

export const listImportedRecipesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({
        search: z.string().trim().max(120).optional(),
        servicePeriod: z.string().trim().max(40).optional(),
        status: z.string().trim().max(40).optional(),
        completeness: z.enum(["complete", "incomplete"]).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./recipe-import.server");
    return mod.listImportedRecipes(context.supabase, context.userId, data);
  });

export const listRecipeImportBatchesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tenantOnly.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./recipe-import.server");
    return mod.listRecipeImportBatches(context.supabase, context.userId, data.tenantId);
  });

export const listRecipeReviewQueueFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({
        batchId: z.string().uuid().optional(),
        entityType: z.enum(["recipe", "recipe_line"]).optional(),
        includeResolved: z.boolean().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./recipe-import.server");
    return mod.listRecipeReviewQueue(context.supabase, context.userId, data);
  });

export const resolveRecipeReviewRowFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({ rowId: z.string().uuid(), note: z.string().trim().max(500).optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./recipe-import.server");
    return mod.resolveRecipeReviewRow(context.supabase, context.userId, data);
  });

export const mapRecipeLineToItemFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly.extend({ lineId: z.string().uuid(), inventoryItemId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./recipe-import.server");
    return mod.mapRecipeLineToItem(context.supabase, context.userId, data);
  });

export const listIngredientMappingQueueFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({
        state: z.enum(["unmapped", "suggested", "confirmed", "review_required", "all"]).optional(),
        recipeId: z.string().uuid().optional(),
        servicePeriod: z.string().trim().max(40).optional(),
        search: z.string().trim().max(120).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./mapping.server");
    return mod.listIngredientMappingQueue(context.supabase, context.userId, data);
  });

export const decideIngredientMappingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({
        lineId: z.string().uuid(),
        decision: z.enum(["confirmed", "rejected", "left_unresolved", "review_required"]),
        inventoryItemId: z.string().uuid().nullish(),
        note: z.string().trim().max(500).nullish(),
        applyToMatchingLines: z.boolean().optional(),
        acknowledgeUnknownUnit: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./mapping.server");
    return mod.decideIngredientMapping(context.supabase, context.userId, data);
  });

export const listMappingDecisionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({
        lineId: z.string().uuid().optional(),
        ingredientKey: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./mapping.server");
    return mod.listMappingDecisions(context.supabase, context.userId, data);
  });
