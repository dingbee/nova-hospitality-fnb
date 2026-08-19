import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  barSnapshotSchema,
  beverageVarianceSchema,
  compDrinkSchema,
  flagVarianceSchema,
  listBeveragesSchema,
  savePourConfigSchema,
} from "./contracts";

export const getBarSnapshotFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => barSnapshotSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bar.server");
    return mod.getBarSnapshot(context.supabase, context.userId, data);
  });

export const listBarBeveragesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listBeveragesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bar.server");
    return mod.listBeverages(context.supabase, context.userId, data);
  });

export const saveBarPourConfigFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => savePourConfigSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bar.server");
    return mod.savePourConfig(context.supabase, context.userId, data);
  });

export const barBeverageVarianceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => beverageVarianceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bar.server");
    return mod.beverageVariance(context.supabase, context.userId, data);
  });

export const flagBarVarianceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => flagVarianceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bar.server");
    return mod.flagBeverageVariance(context.supabase, context.userId, data);
  });

export const compBarDrinkFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => compDrinkSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bar.server");
    return mod.compOrderItem(context.supabase, context.userId, data);
  });