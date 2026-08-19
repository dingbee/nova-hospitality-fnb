import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  createPurchaseOrderSchema,
  listPurchaseOrdersSchema,
  transitionPurchaseOrderSchema,
} from "../core/contracts";
import { getPurchaseOrderDetailSchema } from "./contracts";

export const listRestaurantPurchaseOrdersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listPurchaseOrdersSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./purchasing.server");
    return mod.listPurchaseOrders(context.supabase, context.userId, data);
  });

export const createRestaurantPurchaseOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createPurchaseOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./purchasing.server");
    return mod.createPurchaseOrder(context.supabase, context.userId, data);
  });

export const transitionRestaurantPurchaseOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => transitionPurchaseOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./purchasing.server");
    return mod.transitionPurchaseOrder(context.supabase, context.userId, data);
  });

export const getRestaurantPurchaseOrderDetailFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getPurchaseOrderDetailSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./purchasing.server");
    return mod.getPurchaseOrderDetail(context.supabase, context.userId, data.tenantId, data.id);
  });