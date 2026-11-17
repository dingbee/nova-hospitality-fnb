import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  approveRequisitionSchema,
  cancelRequisitionSchema,
  getRequisitionSchema,
  issueRequisitionSchema,
  listRequisitionsSchema,
  rejectRequisitionSchema,
  saveRequisitionDraftSchema,
  submitRequisitionSchema,
} from "./contracts";

export const listRequisitionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listRequisitionsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requisitions.server");
    return mod.listRequisitions(context.supabase, context.userId, data);
  });

export const getRequisitionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getRequisitionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requisitions.server");
    return mod.getRequisition(context.supabase, context.userId, data.tenantId, data.id);
  });

export const saveRequisitionDraftFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveRequisitionDraftSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requisitions.server");
    return mod.saveRequisitionDraft(context.supabase, context.userId, data);
  });

export const submitRequisitionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => submitRequisitionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requisitions.server");
    return mod.submitRequisition(context.supabase, context.userId, data);
  });

export const approveRequisitionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => approveRequisitionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requisitions.server");
    return mod.approveRequisition(context.supabase, context.userId, data);
  });

export const rejectRequisitionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => rejectRequisitionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requisitions.server");
    return mod.rejectRequisition(context.supabase, context.userId, data);
  });

export const cancelRequisitionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelRequisitionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requisitions.server");
    return mod.cancelRequisition(context.supabase, context.userId, data);
  });

export const issueRequisitionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => issueRequisitionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./requisitions.server");
    return mod.issueRequisition(context.supabase, context.userId, data);
  });
