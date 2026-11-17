import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  listCategoriesSchema,
  listMenuItemsSchema,
  listMenusSchema,
  upsertMenuItemSchema,
  upsertMenuSchema,
} from "../core/contracts";

export const listRestaurantMenusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listMenusSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./menu.server");
    return mod.listMenus(context.supabase, context.userId, data);
  });

export const upsertRestaurantMenuFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertMenuSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./menu.server");
    return mod.upsertMenu(context.supabase, context.userId, data);
  });

export const listRestaurantMenuItemsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listMenuItemsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./menu.server");
    return mod.listMenuItems(context.supabase, context.userId, data);
  });

export const upsertRestaurantMenuItemFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertMenuItemSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./menu.server");
    return mod.upsertMenuItem(context.supabase, context.userId, data);
  });

export const listRestaurantCategoriesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCategoriesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./menu.server");
    return mod.listCategories(context.supabase, context.userId, data);
  });