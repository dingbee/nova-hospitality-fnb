import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  cancelMobileMoneyCollectionSchema,
  getMobileMoneyAccountSchema,
  getMobileMoneyCollectionSchema,
  getMobileMoneyHealthSchema,
  listMobileMoneyCollectionsForOrderSchema,
  listMobileMoneyReconciliationSchema,
  requestMobileMoneyCollectionSchema,
  reverseMobileMoneyCollectionSchema,
  upsertMobileMoneyAccountSchema,
} from "./contracts";

export const getMobileMoneyAccountFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getMobileMoneyAccountSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.getMobileMoneyAccount(context.supabase, context.userId, data);
  });

export const upsertMobileMoneyAccountFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertMobileMoneyAccountSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.upsertMobileMoneyAccount(context.supabase, context.userId, data);
  });

export const requestMobileMoneyCollectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => requestMobileMoneyCollectionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.requestMobileMoneyCollection(context.supabase, context.userId, data);
  });

export const getMobileMoneyStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getMobileMoneyCollectionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.getMobileMoneyStatus(context.supabase, context.userId, data);
  });

export const listMobileMoneyCollectionsForOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listMobileMoneyCollectionsForOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.listMobileMoneyCollectionsForOrder(context.supabase, context.userId, data);
  });

export const refreshMobileMoneyCollectionStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getMobileMoneyCollectionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.refreshMobileMoneyCollectionStatus(context.supabase, data);
  });

export const confirmMobileMoneyCollectionManuallyFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getMobileMoneyCollectionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.confirmMobileMoneyCollection(context.supabase, {
      tenantId: data.tenantId,
      collectionId: data.collectionId,
      actorUserId: context.userId,
    });
  });

export const cancelMobileMoneyCollectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelMobileMoneyCollectionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.cancelMobileMoneyCollection(context.supabase, context.userId, data);
  });

export const reverseMobileMoneyCollectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => reverseMobileMoneyCollectionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.reverseMobileMoneyCollection(context.supabase, context.userId, data);
  });

export const listMobileMoneyReconciliationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listMobileMoneyReconciliationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.listMobileMoneyReconciliation(context.supabase, context.userId, data);
  });

export const getMobileMoneyHealthFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getMobileMoneyHealthSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./mobilemoney.server");
    return mod.getMobileMoneyHealth(context.supabase, context.userId, data);
  });
