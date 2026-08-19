import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  addOrderItemsSchema,
  createOrderSchema,
  getOrderSchema,
  listOrdersSchema,
  listServicePeriodsSchema,
  listTablesSchema,
  recordPaymentSchema,
  transitionOrderSchema,
  upsertServicePeriodSchema,
  upsertTableSchema,
} from "../core/contracts";

export const listRestaurantServicePeriodsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listServicePeriodsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.listServicePeriods(context.supabase, context.userId, data);
  });

export const upsertRestaurantServicePeriodFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertServicePeriodSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.upsertServicePeriod(context.supabase, context.userId, data);
  });

export const listRestaurantTablesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listTablesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.listTables(context.supabase, context.userId, data);
  });

export const upsertRestaurantTableFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertTableSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.upsertTable(context.supabase, context.userId, data);
  });

export const listRestaurantOrdersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listOrdersSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.listOrders(context.supabase, context.userId, data);
  });

export const getRestaurantOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.getOrder(context.supabase, context.userId, data);
  });

export const createRestaurantOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.createOrder(context.supabase, context.userId, data);
  });

export const addRestaurantOrderItemsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => addOrderItemsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.addOrderItems(context.supabase, context.userId, data);
  });

export const recordRestaurantPaymentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordPaymentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.recordPayment(context.supabase, context.userId, data);
  });

export const transitionRestaurantOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => transitionOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./sales.server");
    return mod.transitionOrder(context.supabase, context.userId, data);
  });
