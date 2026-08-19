import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  billStageSchema,
  deliverReceiptSchema,
  getBillSchema,
  listReceiptsSchema,
  refundPaymentSchema,
  releaseTableSchema,
} from "./bill.contracts";

export const getRestaurantBillFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getBillSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bill.server");
    return mod.getBill(context.supabase, context.userId, data);
  });

export const requestRestaurantBillFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => billStageSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bill.server");
    return mod.requestBill(context.supabase, context.userId, data);
  });

export const presentRestaurantBillFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => billStageSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bill.server");
    return mod.presentBill(context.supabase, context.userId, data);
  });

export const releaseRestaurantTableFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => releaseTableSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bill.server");
    return mod.releaseTable(context.supabase, context.userId, data);
  });

export const refundRestaurantPaymentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => refundPaymentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bill.server");
    return mod.refundPayment(context.supabase, context.userId, data);
  });

export const deliverRestaurantReceiptFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => deliverReceiptSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bill.server");
    return mod.deliverReceipt(context.supabase, context.userId, data);
  });

export const listRestaurantReceiptsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listReceiptsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./bill.server");
    return mod.listReceipts(context.supabase, context.userId, data);
  });