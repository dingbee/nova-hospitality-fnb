import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  menuBoardSchema,
  menuDeleteSchema,
  menuLifecycleSchema,
  setIngredientAllergensSchema,
  verifyMenuAllergensSchema,
} from "./lifecycle.contracts";
import { z } from "zod";

export const getMenuBoardFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => menuBoardSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./lifecycle.server");
    return mod.getMenuBoard(context.supabase, context.userId, data);
  });

export const transitionMenuItemFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => menuLifecycleSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./lifecycle.server");
    return mod.transitionMenuItem(context.supabase, context.userId, data);
  });

export const deleteMenuItemFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => menuDeleteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./lifecycle.server");
    return mod.deleteMenuItem(context.supabase, context.userId, data);
  });

export const getMenuAllergenProfilesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./allergens.server");
    return mod.getMenuAllergenProfiles(context.supabase, context.userId, data.tenantId);
  });

export const setIngredientAllergensFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setIngredientAllergensSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./allergens.server");
    return mod.setIngredientAllergens(context.supabase, context.userId, data);
  });

export const verifyMenuAllergensFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => verifyMenuAllergensSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./allergens.server");
    return mod.verifyMenuItemAllergens(context.supabase, context.userId, data);
  });