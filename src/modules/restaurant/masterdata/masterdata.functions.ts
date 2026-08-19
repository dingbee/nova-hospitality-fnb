import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  listAllMasterDataSchema,
  listInventoryCategoriesSchema,
  upsertBusinessProfileSchema,
  upsertInventoryCategorySchema,
  upsertInventoryUnitSchema,
  upsertProductCategorySchema,
  upsertPropertySchema,
} from "./contracts";

export const listRestaurantMasterDataFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listAllMasterDataSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./masterdata.server");
    return mod.listAllMasterData(context.supabase, context.userId, data);
  });

export const upsertRestaurantPropertyFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertPropertySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./masterdata.server");
    return mod.upsertProperty(context.supabase, context.userId, data);
  });

export const upsertRestaurantBusinessProfileFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertBusinessProfileSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./masterdata.server");
    return mod.upsertBusinessProfile(context.supabase, context.userId, data);
  });

export const upsertRestaurantInventoryUnitFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertInventoryUnitSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./masterdata.server");
    return mod.upsertInventoryUnit(context.supabase, context.userId, data);
  });

export const listRestaurantInventoryCategoriesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listInventoryCategoriesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./masterdata.server");
    return mod.listInventoryCategories(context.supabase, context.userId, data);
  });

export const upsertRestaurantInventoryCategoryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertInventoryCategorySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./masterdata.server");
    return mod.upsertInventoryCategory(context.supabase, context.userId, data);
  });

export const upsertRestaurantProductCategoryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertProductCategorySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./masterdata.server");
    return mod.upsertProductCategory(context.supabase, context.userId, data);
  });
