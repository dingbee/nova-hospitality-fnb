import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  askLexiBitePurchaseOrderInputSchema,
  askLexiBitePurchaseOrderTransitionSchema,
  receiveAskLexiBitePurchaseOrderSchema,
  createAskLexiBitePurchaseOrder,
  transitionAskLexiBitePurchaseOrder,
  receiveAskLexiBitePurchaseOrder,
  intelligentPurchaseOrderPlanInputSchema,
  previewIntelligentPurchaseOrders,
  createIntelligentPurchaseOrders,
} from "./ask-lexibite.server";

export const previewIntelligentPurchaseOrdersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => intelligentPurchaseOrderPlanInputSchema.parse(d))
  .handler(async ({ data, context }) =>
    previewIntelligentPurchaseOrders(context.supabase, context.userId, data),
  );

export const createIntelligentPurchaseOrdersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => intelligentPurchaseOrderPlanInputSchema.parse(d))
  .handler(async ({ data, context }) =>
    createIntelligentPurchaseOrders(context.supabase, context.userId, data),
  );
export const createAskLexiBitePurchaseOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => askLexiBitePurchaseOrderInputSchema.parse(d))
  .handler(async ({ data, context }) =>
    createAskLexiBitePurchaseOrder(context.supabase, context.userId, data),
  );

export const transitionAskLexiBitePurchaseOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => askLexiBitePurchaseOrderTransitionSchema.parse(d))
  .handler(async ({ data, context }) =>
    transitionAskLexiBitePurchaseOrder(context.supabase, context.userId, data),
  );

export const receiveAskLexiBitePurchaseOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => receiveAskLexiBitePurchaseOrderSchema.parse(d))
  .handler(async ({ data, context }) =>
    receiveAskLexiBitePurchaseOrder(context.supabase, context.userId, data),
  );
