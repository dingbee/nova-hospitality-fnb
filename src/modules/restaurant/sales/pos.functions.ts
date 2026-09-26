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
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, data.propertyId);
    return mod.posBoard(context.supabase, actorId, data);
  });

export const posCatalogFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => posCatalogSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, data.propertyId);
    return mod.posCatalog(context.supabase, actorId, data);
  });

export const openPosOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => openPosOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, data.propertyId);
    return mod.openPosOrder(context.supabase, actorId, data);
  });

export const addPosLinesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => addPosLinesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, data.propertyId);
    return mod.addPosLines(context.supabase, actorId, data);
  });

export const voidPosLineFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => voidPosLineSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, data.propertyId);
    return mod.voidPosLine(context.supabase, actorId, data);
  });

export const transferPosOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => transferPosOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, data.propertyId);
    return mod.transferPosOrder(context.supabase, actorId, data);
  });

export const takePosPaymentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => posPaymentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, data.propertyId);
    return mod.takePosPayment(context.supabase, actorId, data);
  });

export const reopenPosOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => reopenPosOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pos.server");
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, data.propertyId);
    return mod.reopenPosOrder(context.supabase, actorId, data);
  });

export const cancelPosOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./cancellation.server");
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, data.propertyId);
    return mod.cancelOrder(context.supabase, actorId, data);
  });

export const posReceiptFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => posReceiptSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./receipts.server");
    const actorId = await (await import("./pos-session.server")).resolvePosActor(context.supabase, context.userId, data.posSessionId, data.tenantId, undefined);
    return data.reprint
      ? mod.issueReceipt(context.supabase, actorId, data)
      : mod.getReceipt(context.supabase, actorId, data);
  });