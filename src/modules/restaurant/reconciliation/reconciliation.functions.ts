import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  closeDaySchema,
  declareTendersSchema,
  exceptionTrendSchema,
  getDailyCloseSchema,
  listDailyClosesSchema,
  listExceptionsSchema,
  listReconciliationAuditSchema,
  openDailyCloseSchema,
  reopenDaySchema,
  resolveExceptionSchema,
  runReconciliationSchema,
} from "./contracts";

export const openRestaurantDailyCloseFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => openDailyCloseSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.openDailyClose(context.supabase, context.userId, data);
  });

export const getRestaurantDailyCloseFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getDailyCloseSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.getDailyClose(context.supabase, context.userId, data);
  });

export const listRestaurantDailyClosesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listDailyClosesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.listDailyCloses(context.supabase, context.userId, data);
  });

export const declareRestaurantTendersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => declareTendersSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.declareTenders(context.supabase, context.userId, data);
  });

export const runRestaurantReconciliationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => runReconciliationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.runReconciliation(context.supabase, context.userId, data);
  });

export const listRestaurantExceptionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listExceptionsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.listExceptions(context.supabase, context.userId, data);
  });

export const resolveRestaurantExceptionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => resolveExceptionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.resolveException(context.supabase, context.userId, data);
  });

export const closeRestaurantDayFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => closeDaySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.closeDay(context.supabase, context.userId, data);
  });

export const reopenRestaurantDayFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => reopenDaySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.reopenDay(context.supabase, context.userId, data);
  });

export const restaurantExceptionTrendsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => exceptionTrendSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.exceptionTrends(context.supabase, context.userId, data);
  });

export const listRestaurantReconciliationAuditFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listReconciliationAuditSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reconciliation.server");
    return mod.listReconciliationAudit(context.supabase, context.userId, data);
  });