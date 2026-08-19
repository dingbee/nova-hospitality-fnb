import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const tenantOnly = z.object({ tenantId: z.string().uuid() });

export const getRecipeGapAnalysisFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tenantOnly.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./gap-analysis.server");
    return mod.getRecipeGapAnalysis(context.supabase, context.userId, data);
  });

export const listMissingCatalogItemsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tenantOnly.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./gap-analysis.server");
    return mod.listMissingCatalogItems(context.supabase, context.userId, data);
  });

export const reviewCatalogItemRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({
        ingredientKey: z.string().trim().min(1).max(200),
        ingredientName: z.string().trim().min(1).max(200),
        occurrences: z.number().int().min(1).max(10000).optional(),
        decision: z.enum(["approve", "reject"]),
        suggestedDomain: z.string().trim().max(12).nullish(),
        suggestedCategory: z.string().trim().max(120).nullish(),
        suggestedSubcategory: z.string().trim().max(120).nullish(),
        suggestedStockUnitCode: z.string().trim().max(20).nullish(),
        suggestedPurchaseUnitCode: z.string().trim().max(20).nullish(),
        suggestedName: z.string().trim().max(200).nullish(),
        provenance: z.record(z.string(), z.unknown()).optional(),
        note: z.string().trim().max(500).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./gap-analysis.server");
    return mod.reviewCatalogItemRequest(context.supabase, context.userId, data);
  });

export const createCatalogItemFromRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({
        requestId: z.string().uuid(),
        name: z.string().trim().min(2).max(200),
        domain: z.string().trim().min(2).max(12),
        categoryName: z.string().trim().max(120).nullish(),
        subcategory: z.string().trim().max(120).nullish(),
        skuCode: z.string().trim().min(2).max(4),
        stockUnitCode: z.string().trim().max(20).nullish(),
        purchaseUnitCode: z.string().trim().max(20).nullish(),
        note: z.string().trim().max(500).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./gap-analysis.server");
    return mod.createCatalogItemFromRequest(context.supabase, context.userId, data);
  });

export const listStockUnitGapsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tenantOnly.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./gap-analysis.server");
    return mod.listStockUnitGaps(context.supabase, context.userId, data);
  });

export const setCatalogStockUnitFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({
        itemId: z.string().uuid(),
        unitCode: z.string().trim().min(1).max(20),
        note: z.string().trim().max(500).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./gap-analysis.server");
    return mod.setCatalogStockUnit(context.supabase, context.userId, data);
  });

export const markStockUnitUnresolvedFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly
      .extend({ itemId: z.string().uuid(), note: z.string().trim().max(500).nullish() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./gap-analysis.server");
    return mod.markStockUnitUnresolved(context.supabase, context.userId, data);
  });

export const listEnrichmentDecisionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly.extend({ limit: z.number().int().min(1).max(500).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./gap-analysis.server");
    return mod.listEnrichmentDecisions(context.supabase, context.userId, data);
  });