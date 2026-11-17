import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const tenantOnly = z.object({ tenantId: z.string().uuid() });

const listCatalogSchema = tenantOnly.extend({
  search: z.string().trim().max(120).optional(),
  domain: z.string().trim().max(12).optional(),
  categoryId: z.string().uuid().optional(),
  subcategory: z.string().trim().max(120).optional(),
  dataStatus: z.enum(["CONFIRMED", "UNCONFIRMED"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const listMasterCatalogFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCatalogSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.listMasterCatalog(context.supabase, context.userId, data);
  });

export const importMasterCatalogFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly.extend({ propertyId: z.string().uuid().nullish(), dryRun: z.boolean().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.importMasterCatalog(context.supabase, context.userId, data);
  });

export const listCatalogImportBatchesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tenantOnly.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.listCatalogImportBatches(context.supabase, context.userId, data.tenantId);
  });

export const listCatalogReviewQueueFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly.extend({ batchId: z.string().uuid().optional(), includeResolved: z.boolean().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.listCatalogReviewQueue(context.supabase, context.userId, data);
  });

export const resolveCatalogReviewRowFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    tenantOnly.extend({ rowId: z.string().uuid(), note: z.string().trim().max(500).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.resolveCatalogReviewRow(context.supabase, context.userId, data);
  });
