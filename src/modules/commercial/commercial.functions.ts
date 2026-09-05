import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  activateSubscriptionSchema,
  addCommercialNoteSchema,
  approveAgreementSchema,
  cancelAgreementSchema,
  cancelSubscriptionSchema,
  checkQuotaSchema,
  createAgreementSchema,
  generateInvoiceSchema,
  getCustomerProfileSchema,
  grantCommercialAdminSchema,
  issueInvoiceSchema,
  listAgreementsSchema,
  listAuditLogSchema,
  listCustomersSchema,
  listInvoicesSchema,
  listOverridesSchema,
  listPaymentsSchema,
  listPropertyClassificationsSchema,
  reactivateSubscriptionSchema,
  recordPaymentSchema,
  renewSubscriptionSchema,
  resolveEntitlementSchema,
  revokeCommercialAdminSchema,
  revokeOverrideSchema,
  suspendSubscriptionSchema,
  upsertBillingAccountSchema,
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
  voidInvoiceSchema,
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

export const listCommercialTenantsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./catalog.server");
    return mod.listTenants(context.supabase);
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

/* ================================================================= P02 === */

/* --------------------------------------------------------- billing account */

export const listCommercialBillingAccountsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./billing-account.server");
    return mod.listBillingAccounts(context.supabase);
  });

export const getCommercialBillingAccountFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./billing-account.server");
    return mod.getBillingAccount(context.supabase, data.tenantId);
  });

export const upsertCommercialBillingAccountFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertBillingAccountSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./billing-account.server");
    return mod.upsertBillingAccount(context.supabase, context.userId, data);
  });

/* ------------------------------------------------------------- agreements */

export const listCommercialAgreementsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listAgreementsSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const mod = await import("./agreements.server");
    return mod.listAgreements(context.supabase, data);
  });

export const createCommercialAgreementFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createAgreementSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./agreements.server");
    return mod.createAgreement(context.supabase, context.userId, data);
  });

export const approveCommercialAgreementFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => approveAgreementSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./agreements.server");
    return mod.approveAgreement(context.supabase, context.userId, data);
  });

export const cancelCommercialAgreementFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelAgreementSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./agreements.server");
    return mod.cancelAgreement(context.supabase, context.userId, data);
  });

/* --------------------------------------------------- subscription lifecycle */

export const activateCommercialSubscriptionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => activateSubscriptionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./subscription-lifecycle.server");
    return mod.activateSubscription(context.supabase, context.userId, data);
  });

export const cancelCommercialSubscriptionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelSubscriptionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./subscription-lifecycle.server");
    return mod.cancelSubscription(context.supabase, context.userId, data);
  });

export const suspendCommercialSubscriptionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => suspendSubscriptionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./subscription-lifecycle.server");
    return mod.suspendSubscription(context.supabase, context.userId, data);
  });

export const reactivateCommercialSubscriptionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => reactivateSubscriptionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./subscription-lifecycle.server");
    return mod.reactivateSubscription(context.supabase, context.userId, data);
  });

export const renewCommercialSubscriptionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => renewSubscriptionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./subscription-lifecycle.server");
    return mod.renewSubscription(context.supabase, context.userId, data);
  });

/* ------------------------------------------------------------------ billing */

export const listCommercialInvoicesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listInvoicesSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const mod = await import("./billing.server");
    return mod.listInvoices(context.supabase, data);
  });

export const getCommercialInvoiceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./billing.server");
    return mod.getInvoiceWithLines(context.supabase, data.invoiceId);
  });

export const generateCommercialInvoiceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => generateInvoiceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./billing.server");
    return mod.generateInvoice(context.supabase, context.userId, data);
  });

export const issueCommercialInvoiceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => issueInvoiceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./billing.server");
    return mod.issueInvoice(context.supabase, context.userId, data);
  });

export const voidCommercialInvoiceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => voidInvoiceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./billing.server");
    return mod.voidInvoice(context.supabase, context.userId, data);
  });

/* ------------------------------------------------------------------ payments */

export const listCommercialPaymentsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listPaymentsSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const mod = await import("./payments.server");
    return mod.listPayments(context.supabase, data);
  });

export const recordCommercialPaymentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordPaymentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./payments.server");
    return mod.recordPayment(context.supabase, context.userId, data);
  });

/* ----------------------------------------------------------------- documents */

export const renderCommercialDocumentHtmlFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ kind: z.enum(["invoice", "agreement"]), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./documents.server");
    return { html: await mod.renderCommercialDocumentHtml(context.supabase, data.kind, data.id) };
  });

/* ================================================================= P03 === */

export const listCommercialCustomersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCustomersSchema.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const mod = await import("./customers.server");
    return mod.listCustomers(context.supabase, context.userId, data);
  });

export const getCommercialCustomerProfileFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getCustomerProfileSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./customers.server");
    return mod.getCustomerCommercialProfile(context.supabase, context.userId, data.tenantId);
  });

export const addCommercialNoteFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => addCommercialNoteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./customers.server");
    return mod.addCommercialNote(context.supabase, context.userId, data);
  });

export const listCommercialCollectionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./collections.server");
    return mod.listCollections(context.supabase, context.userId);
  });

export const listCommercialUpcomingRenewalsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => empty.parse(d))
  .handler(async ({ context }) => {
    const mod = await import("./renewals.server");
    return mod.listUpcomingRenewals(context.supabase, context.userId);
  });

/* -------------------------------------------------------------- notifications */

export const listCommercialNotificationsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ tenantId: z.string().uuid().optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./notifications.server");
    return mod.listCommercialNotifications(context.supabase, data);
  });
