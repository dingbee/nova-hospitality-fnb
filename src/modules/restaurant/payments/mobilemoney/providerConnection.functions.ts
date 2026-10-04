import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const credentialsSchema = z
  .record(z.string().trim().min(1).max(4000), z.string().max(4000))
  .refine((value) => Object.keys(value).length > 0, "At least one credential is required.");

const configureSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid(),
  providerCode: z.string().min(1).max(40),
  config: z.record(z.string(), z.string().max(1000)).optional(),
  credentials: credentialsSchema,
});

const locationSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid(),
});

export const configureMobileMoneyProviderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => configureSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./providerConnection.server");
    return mod.configureMobileMoneyProvider(context.supabase, context.userId, data);
  });

export const clearMobileMoneyProviderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => locationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./providerConnection.server");
    return mod.clearMobileMoneyProvider(context.supabase, context.userId, data);
  });
