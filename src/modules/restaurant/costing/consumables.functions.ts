import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const scopeSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
});
const saveSchema = scopeSchema.extend({
  name: z.string().trim().min(2).max(120),
  costClass: z.enum(["service_consumable", "other_direct_variable"]),
  inventoryItemId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  quantityPerCover: z.number().positive().max(100000),
});

export const listOperationalConsumptionProfilesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => scopeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./consumables.server");
    return mod.listOperationalConsumptionProfiles(context.supabase, context.userId, data);
  });

export const saveOperationalConsumptionProfileFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./consumables.server");
    return mod.saveOperationalConsumptionProfile(context.supabase, context.userId, data);
  });
