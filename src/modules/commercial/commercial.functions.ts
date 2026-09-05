import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  checkQuotaSchema,
  grantCommercialAdminSchema,
  listAuditLogSchema,
  listOverridesSchema,
  listPropertyClassificationsSchema,
  resolveEntitlementSchema,
  revokeCommercialAdminSchema,
  revokeOverrideSchema,
  upsertCapabilitySchema,
  upsertOverrideSchema,
  upsertPlanEntitlementSchema,
  upsertPlanSchema,
  upsertPricingSchema,
  upsertProgrammeEntitlementSchema,
  upsertProgrammeSchema,
  upsertPropertyPolicySchema,
  upsertQuotaDefinitionSchema,
  upsertSubscriptionSchema,
} from "./contracts";

const empty = z.object({}).optional();

/* ------------------------------------------------------------------ reads */

export const listCommercialPlansFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listPlans(context.supabase);
  });

export const listCommercialCapabilitiesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listCapabilities(context.supabase);
  });

export const listCommercialProgrammesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listProgrammes(context.supabase);
  });

export const listCommercialPlanEntitlementsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listPlanEntitlements(context.supabase);
  });

export const listCommercialProgrammeEntitlementsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listProgrammeEntitlements(context.supabase);
  });

export const listCommercialPricingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listPricing(context.supabase);
  });

export const listCommercialPropertyPoliciesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listPropertyPolicies(context.supabase);
  });

export const listCommercialQuotaDefinitionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listQuotaDefinitions(context.supabase);
  });

export const listCommercialOverridesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listOverridesSchema.partial().parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.listOverrides(context.supabase, data);
  });

export const listCommercialSubscriptionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listSubscriptions(context.supabase);
  });

export const listCommercialPropertyClassificationsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listPropertyClassificationsSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.listPropertyClassifications(context.supabase, data);
  });

export const listCommercialAuditLogFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listAuditLogSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.listAuditLog(context.supabase, data);
  });

export const listCommercialAdministratorsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listCommercialAdministrators(context.supabase);
  });

export const whoAmICommercialFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.whoAmI(context.supabase, context.userId);
  });

export const resolveCommercialEntitlementFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => resolveEntitlementSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./resolver.server");
    return mod.resolveEntitlement(context.supabase, data.tenantId, data.capabilityCode, {
      propertyId: data.propertyId,
    });
  });

export const checkCommercialQuotaFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => checkQuotaSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./quota.server");
    return mod.checkQuota(context.supabase, data.tenantId, data.quotaCode, data.propertyId);
  });

/* -------------------------------------------------------------- admin CRUD */

export const upsertCommercialPlanFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertPlanSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertPlan(context.supabase, context.userId, data);
  });

export const upsertCommercialCapabilityFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertCapabilitySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertCapability(context.supabase, context.userId, data);
  });

export const upsertCommercialProgrammeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertProgrammeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertProgramme(context.supabase, context.userId, data);
  });

export const upsertCommercialPlanEntitlementFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertPlanEntitlementSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertPlanEntitlement(context.supabase, context.userId, data);
  });

export const upsertCommercialProgrammeEntitlementFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertProgrammeEntitlementSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertProgrammeEntitlement(context.supabase, context.userId, data);
  });

export const upsertCommercialPricingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertPricingSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertPricing(context.supabase, context.userId, data);
  });

export const upsertCommercialPropertyPolicyFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertPropertyPolicySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertPropertyPolicy(context.supabase, context.userId, data);
  });

export const upsertCommercialQuotaDefinitionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertQuotaDefinitionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertQuotaDefinition(context.supabase, context.userId, data);
  });

export const upsertCommercialOverrideFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertOverrideSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertOverride(context.supabase, context.userId, data);
  });

export const revokeCommercialOverrideFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => revokeOverrideSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.revokeOverride(context.supabase, context.userId, data);
  });

export const upsertCommercialSubscriptionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertSubscriptionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.upsertSubscription(context.supabase, context.userId, data);
  });

export const grantCommercialAdminFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => grantCommercialAdminSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.grantCommercialAdmin(context.supabase, context.userId, data);
  });

export const revokeCommercialAdminFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => revokeCommercialAdminSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./catalog.server");
    return mod.revokeCommercialAdmin(context.supabase, context.userId, data);
  });
