import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  bootstrapTenantSchema,
  createFirstOutletSchema,
  getOnboardingStatusSchema,
  setOperatingModelSchema,
} from "./contracts";

export const bootstrapTenantFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => bootstrapTenantSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./onboarding.server");
    return mod.bootstrapTenant(context.supabase, context.userId, data);
  });

export const createFirstOutletFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createFirstOutletSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./onboarding.server");
    return mod.createFirstOutlet(context.supabase, context.userId, data);
  });

export const setOperatingModelFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setOperatingModelSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./onboarding.server");
    return mod.setOperatingModel(context.supabase, context.userId, data);
  });

export const getOnboardingStatusFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getOnboardingStatusSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./onboarding.server");
    return mod.getOnboardingStatus(context.supabase, context.userId, data.tenantId);
  });
