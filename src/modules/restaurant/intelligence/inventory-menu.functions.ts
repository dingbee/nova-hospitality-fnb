import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const opportunitySchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  windowDays: z.number().int().min(7).max(120).default(30),
  targetCoverDays: z.number().int().min(1).max(60).default(7),
});

export const getInventoryMenuOpportunitiesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => opportunitySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./inventory-menu.server");
    return mod.getInventoryMenuOpportunities(context.supabase, context.userId, data);
  });

export const publishOpportunityEventsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => opportunitySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./inventory-menu.server");
    return mod.publishOpportunityEvents(context.supabase, context.userId, data);
  });