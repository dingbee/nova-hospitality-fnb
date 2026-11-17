import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  getFiscalConfigurationSchema,
  getFiscalHealthSchema,
  getFiscalStatusForOrderSchema,
  listFiscalReceiptsSchema,
  prepareZReportDraftSchema,
  requestFiscalizationSchema,
  upsertFiscalConfigurationSchema,
} from "./contracts";

export const getFiscalConfigurationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getFiscalConfigurationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.getFiscalConfiguration(context.supabase, context.userId, data);
  });

export const upsertFiscalConfigurationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertFiscalConfigurationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.upsertFiscalConfiguration(context.supabase, context.userId, data);
  });

export const getFiscalStatusForOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getFiscalStatusForOrderSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.getFiscalStatusForOrder(context.supabase, context.userId, data);
  });

export const requestFiscalizationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => requestFiscalizationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.requestFiscalization(context.supabase, context.userId, data);
  });

export const listFiscalReceiptsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listFiscalReceiptsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.listFiscalReceipts(context.supabase, context.userId, data);
  });

export const getFiscalHealthFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getFiscalHealthSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.getFiscalHealth(context.supabase, context.userId, data);
  });

export const prepareZReportDraftFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => prepareZReportDraftSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.prepareZReportDraft(context.supabase, context.userId, data);
  });

export const registerFiscalVfdFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getFiscalConfigurationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.registerFiscalVfd(context.supabase, context.userId, data);
  });

export const testFiscalConnectionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getFiscalConfigurationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.testFiscalConnection(context.supabase, context.userId, data);
  });

export const getFiscalRegistrationStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getFiscalConfigurationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.getFiscalRegistrationStatus(context.supabase, context.userId, data);
  });

export const submitZReportForBusinessDateFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => prepareZReportDraftSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./fiscal.server");
    return mod.submitZReportForBusinessDate(context.supabase, context.userId, data);
  });
