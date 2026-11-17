import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const tenantFilterSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(250).optional(),
});

export const listWhatsAppInboxFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantFilterSchema.parse(data))
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.listWhatsAppInbox(context.supabase, context.userId, data);
  });

export const getWhatsAppConversationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    tenantFilterSchema.extend({ conversationId: z.string().uuid() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.getWhatsAppConversation(context.supabase, context.userId, data);
  });

export const listWhatsAppGuestCRMFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantFilterSchema.parse(data))
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.listWhatsAppGuestCRM(context.supabase, context.userId, data);
  });

export const getWhatsAppCampaignWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantFilterSchema.parse(data))
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.getWhatsAppCampaignWorkspace(context.supabase, context.userId, data);
  });

export const getWhatsAppUsageReportFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantFilterSchema.parse(data))
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.getWhatsAppUsageReport(context.supabase, context.userId, data);
  });

export const getWhatsAppConversionReportFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => tenantFilterSchema.parse(data))
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.getWhatsAppConversionReport(context.supabase, context.userId, data);
  });

export const getFounderWhatsAppOverviewFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({}).parse(data ?? {}))
  .handler(async ({ context }) => {
    const mod = await import("./operations.server");
    return mod.getFounderWhatsAppOverview(context.supabase, context.userId);
  });
