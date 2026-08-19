import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  addPosLinesSchema,
  cancelOrderSchema,
  openPosOrderSchema,
  posBoardSchema,
  posCatalogSchema,
  posPaymentSchema,
  posReceiptSchema,
  reopenPosOrderSchema,
  transferPosOrderSchema,
  voidPosLineSchema,
} from "./pos.contracts";

export const posBoardFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => posBoardSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    return mod.posBoard(context.supabase, context.userId, data);
  });

export const posCatalogFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => posCatalogSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    return mod.posCatalog(context.supabase, context.userId, data);
  });

export const openPosOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => openPosOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    return mod.openPosOrder(context.supabase, context.userId, data);
  });

export const addPosLinesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => addPosLinesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    return mod.addPosLines(context.supabase, context.userId, data);
  });

export const voidPosLineFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => voidPosLineSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    return mod.voidPosLine(context.supabase, context.userId, data);
  });

export const transferPosOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => transferPosOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    return mod.transferPosOrder(context.supabase, context.userId, data);
  });

export const takePosPaymentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => posPaymentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    return mod.takePosPayment(context.supabase, context.userId, data);
  });

export const reopenPosOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => reopenPosOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    return mod.reopenPosOrder(context.supabase, context.userId, data);
  });

export const cancelPosOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./cancellation.server");
    return mod.cancelOrder(context.supabase, context.userId, data);
  });

export const posReceiptFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => posReceiptSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./receipts.server");
    return data.reprint
      ? mod.issueReceipt(context.supabase, context.userId, data)
      : mod.getReceipt(context.supabase, context.userId, data);
  });