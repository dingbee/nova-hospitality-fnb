/**
 * P05 — server-fn wrappers for the six primary Pro capabilities plus
 * Multi-Location Command. Mirrors insights.functions.ts's pattern exactly:
 * validate input, dynamic-import the server module, delegate. No logic
 * lives here — every entitlement/RBAC check happens inside the server
 * modules themselves.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  p05ForecastWindowSchema,
  p05MultiLocationWindowSchema,
  p05WindowSchema,
} from "./p05.types";

export const getRestaurantDemandIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => p05WindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./demand.server");
    return mod.getDemandIntelligence(context.supabase, context.userId, data);
  });

export const getRestaurantForecastingIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => p05ForecastWindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./forecasting.server");
    return mod.getForecastingIntelligence(context.supabase, context.userId, data);
  });

export const getRestaurantRevenueIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => p05WindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./revenue.server");
    return mod.getRevenueIntelligence(context.supabase, context.userId, data);
  });

export const getRestaurantAdvancedAnalyticsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => p05WindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./advancedAnalytics.server");
    return mod.getAdvancedAnalyticsIntelligence(context.supabase, context.userId, data);
  });

export const getRestaurantExecutiveIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => p05WindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./executive.server");
    return mod.getExecutiveIntelligence(context.supabase, context.userId, data);
  });

export const getRestaurantMultiLocationIntelligenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => p05MultiLocationWindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./multiLocation.server");
    return mod.getMultiLocationIntelligence(context.supabase, context.userId, data);
  });

export const getRestaurantInventoryIntelligenceProFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => p05WindowSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./inventoryPro.server");
    return mod.getInventoryIntelligencePro(context.supabase, context.userId, data);
  });
