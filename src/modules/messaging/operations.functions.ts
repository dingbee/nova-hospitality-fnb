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

const templateDraftSchema = tenantFilterSchema.extend({
  templateName: z.string().regex(/^[a-z0-9_]{3,512}$/),
  language: z.string().regex(/^[a-z]{2}([_-][A-Z]{2})?$/),
  category: z.enum(["marketing", "utility", "authentication"]),
  components: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const createWhatsAppTemplateDraftFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => templateDraftSchema.parse(data))
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.createWhatsAppTemplateDraft(context.supabase, context.userId, data);
  });

const campaignDraftSchema = tenantFilterSchema.extend({
  propertyId: z.string().uuid(),
  locationId: z.string().uuid(),
  bindingId: z.string().uuid(),
  marketCode: z.string().regex(/^[A-Z]{2,3}$/),
  templateId: z.string().uuid(),
  name: z.string().min(2).max(160),
  triggerType: z.enum(["scheduled", "event"]),
  eventKey: z.string().max(160).optional(),
  scheduledAt: z.string().datetime().optional(),
  dailyCap: z.number().int().min(0).nullable().optional(),
  totalCap: z.number().int().min(0).nullable().optional(),
  preferredLanguage: z.enum(["en", "sw"]).optional(),
});

export const createWhatsAppCampaignDraftFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => campaignDraftSchema.parse(data))
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.createWhatsAppCampaignDraft(context.supabase, context.userId, data);
  });

const campaignActionSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid(),
  campaignId: z.string().uuid(),
});

export const activateWhatsAppCampaignFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => campaignActionSchema.parse(data))
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.activateWhatsAppCampaignForTenant(context.supabase, context.userId, data);
  });

export const pauseWhatsAppCampaignFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => campaignActionSchema.parse(data))
  .handler(async ({ data, context }) => {
    const mod = await import("./operations.server");
    return mod.pauseWhatsAppCampaignForTenant(context.supabase, context.userId, data);
  });
