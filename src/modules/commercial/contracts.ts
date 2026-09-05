/**
 * P01 — Commercial Control Architecture (browser-safe contracts).
 *
 * LexiBite's commercial policy — plans, capabilities, entitlements, quotas,
 * pricing, property policy, the Founding 10 programme, and commercial
 * overrides — lives in the `commercial_*` tables (migration
 * 0034_p01_commercial_architecture.sql), not in application code. This
 * module is the single place the shape of that policy is declared for the
 * browser and the server to share.
 *
 * Tenant/property/outlet identity is NOT re-declared here: it is the
 * existing `restaurant_tenants` / `restaurant_properties` / `restaurant_locations`
 * tree (see modules/restaurant/core/contracts.ts). This module only adds the
 * commercial policy layered on top of it.
 */
import { z } from "zod";

const uuid = z.string().uuid();

/* --------------------------------------------------------------- plans */

export const PLAN_CODES = ["core", "pro", "enterprise"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const PLAN_STATUSES = ["active", "deprecated", "draft"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const CAPABILITY_STATUSES = ["active", "coming_soon", "deprecated"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const PROGRAMME_STATUSES = ["active", "ended", "draft"] as const;
export type ProgrammeStatus = (typeof PROGRAMME_STATUSES)[number];

/* ------------------------------------------------------------ entitlements */

export const ENTITLEMENT_STATES = [
  "included",
  "limited",
  "advanced",
  "enterprise",
  "add_on",
  "unavailable",
  "coming_soon",
] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];

export const ENTITLEMENT_STATE_LABELS: Record<EntitlementState, string> = {
  included: "Included",
  limited: "Limited",
  advanced: "Advanced",
  enterprise: "Enterprise",
  add_on: "Add-on",
  unavailable: "Not available",
  coming_soon: "Coming soon",
};

/* ------------------------------------------------------------------ quotas */

export const QUOTA_UNITS = [
  "count",
  "quantity",
  "tokens",
  "storage",
  "api_calls",
  "intelligence_runs",
  "ai_requests",
  "model_usage",
  "property_usage",
  "tenant_usage",
] as const;
export type QuotaUnit = (typeof QUOTA_UNITS)[number];

export const QUOTA_PERIODS = ["day", "week", "month", "year", "billing_cycle"] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

export const QUOTA_SCOPES = ["tenant", "property", "user"] as const;
export type QuotaScope = (typeof QUOTA_SCOPES)[number];

export const OVERAGE_BEHAVIORS = [
  "block",
  "allow_with_admin_override",
  "allow_within_fair_use",
  "route_to_lower_cost_model",
  "require_upgrade",
  "notify_admin",
] as const;
export type OverageBehavior = (typeof OVERAGE_BEHAVIORS)[number];

export const USAGE_STATES = [
  "NORMAL",
  "WARNING",
  "NEAR_LIMIT",
  "LIMIT_REACHED",
  "BLOCKED",
  "OVERRIDE",
] as const;
export type UsageState = (typeof USAGE_STATES)[number];

/* --------------------------------------------------------------- pricing */

export const BILLING_INTERVALS = ["monthly", "annual", "custom"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const TAX_TREATMENTS = ["inclusive", "exclusive", "exempt"] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export const PRICING_STATUSES = ["active", "draft", "archived"] as const;
export type PricingStatus = (typeof PRICING_STATUSES)[number];

/* ------------------------------------------------------------- properties */

export const PROPERTY_CLASSIFICATIONS = [
  "base",
  "included",
  "additional_included",
  "additional_chargeable",
  "programme_covered",
  "override_covered",
  "enterprise",
] as const;
export type PropertyClassification = (typeof PROPERTY_CLASSIFICATIONS)[number];

/* -------------------------------------------------------------- overrides */

export const OVERRIDE_SCOPE_TYPES = [
  "tenant",
  "subscription",
  "property",
  "programme",
  "contract",
  "capability",
  "quota",
  "pricing",
] as const;
export type OverrideScopeType = (typeof OVERRIDE_SCOPE_TYPES)[number];

export const OVERRIDE_STATUSES = ["active", "revoked", "expired"] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];

/* ------------------------------------------------------------ CRUD input */

export const upsertPlanSchema = z.object({
  id: uuid.optional(),
  code: z.enum(PLAN_CODES),
  name: z.string().min(2).max(80),
  description: z.string().max(2000).optional(),
  status: z.enum(PLAN_STATUSES).default("active"),
  sortOrder: z.number().int().min(0).default(0),
});
export type UpsertPlanInput = z.infer<typeof upsertPlanSchema>;

export const upsertCapabilitySchema = z.object({
  id: uuid.optional(),
  code: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9_]+$/),
  name: z.string().min(2).max(120),
  description: z.string().max(2000).optional(),
  category: z.string().min(2).max(60).default("operations"),
  status: z.enum(CAPABILITY_STATUSES).default("active"),
  sortOrder: z.number().int().min(0).default(0),
});
export type UpsertCapabilityInput = z.infer<typeof upsertCapabilitySchema>;

export const upsertProgrammeSchema = z.object({
  id: uuid.optional(),
  code: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9_]+$/),
  name: z.string().min(2).max(120),
  description: z.string().max(2000).optional(),
  status: z.enum(PROGRAMME_STATUSES).default("active"),
  eligibility: z.record(z.string(), z.unknown()).default({}),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  supportSlaOverride: z.string().max(200).optional(),
  contractReference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});
export type UpsertProgrammeInput = z.infer<typeof upsertProgrammeSchema>;

export const upsertPlanEntitlementSchema = z.object({
  id: uuid.optional(),
  planId: uuid,
  capabilityId: uuid,
  state: z.enum(ENTITLEMENT_STATES),
  config: z.record(z.string(), z.unknown()).default({}),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
});
export type UpsertPlanEntitlementInput = z.infer<typeof upsertPlanEntitlementSchema>;

export const upsertProgrammeEntitlementSchema = z.object({
  id: uuid.optional(),
  programmeId: uuid,
  capabilityId: uuid,
  state: z.enum(ENTITLEMENT_STATES),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type UpsertProgrammeEntitlementInput = z.infer<typeof upsertProgrammeEntitlementSchema>;

export const upsertPricingSchema = z.object({
  id: uuid.optional(),
  planId: uuid,
  programmeId: uuid.optional(),
  currency: z.string().min(3).max(8).default("TZS"),
  monthlyPrice: z.number().min(0).optional(),
  annualPrice: z.number().min(0).optional(),
  additionalPropertyPrice: z.number().min(0).optional(),
  implementationFee: z.number().min(0).optional(),
  billingInterval: z.enum(BILLING_INTERVALS).default("monthly"),
  taxTreatment: z.enum(TAX_TREATMENTS).default("exclusive"),
  trialDays: z.number().int().min(0).default(0),
  discountPct: z.number().min(0).max(100).optional(),
  status: z.enum(PRICING_STATUSES).default("active"),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
});
export type UpsertPricingInput = z.infer<typeof upsertPricingSchema>;

export const upsertPropertyPolicySchema = z.object({
  id: uuid.optional(),
  planId: uuid,
  programmeId: uuid.optional(),
  includedProperties: z.number().int().min(0).default(1),
  additionalPropertyPrice: z.number().min(0).optional(),
  propertyLimit: z.number().int().min(0).optional(),
  requiresApprovalAbove: z.number().int().min(0).optional(),
  enterpriseTreatment: z.boolean().default(false),
  status: z.enum(PRICING_STATUSES).default("active"),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
});
export type UpsertPropertyPolicyInput = z.infer<typeof upsertPropertyPolicySchema>;

export const upsertQuotaDefinitionSchema = z.object({
  id: uuid.optional(),
  code: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9_]+$/),
  capabilityId: uuid.optional(),
  planId: uuid.optional(),
  programmeId: uuid.optional(),
  unit: z.enum(QUOTA_UNITS),
  limitValue: z.number().min(0),
  period: z.enum(QUOTA_PERIODS).default("month"),
  scope: z.enum(QUOTA_SCOPES).default("tenant"),
  warningThresholdPct: z.number().min(0).max(1000).default(80),
  nearLimitThresholdPct: z.number().min(0).max(1000).default(95),
  overageBehavior: z.enum(OVERAGE_BEHAVIORS).default("block"),
  active: z.boolean().default(true),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
});
export type UpsertQuotaDefinitionInput = z.infer<typeof upsertQuotaDefinitionSchema>;

export const upsertOverrideSchema = z.object({
  id: uuid.optional(),
  scopeType: z.enum(OVERRIDE_SCOPE_TYPES),
  scopeId: uuid.optional(),
  tenantId: uuid.optional(),
  overrideType: z.string().min(2).max(80),
  payload: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().min(5).max(2000),
  approvalReference: z.string().max(200).optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
});
export type UpsertOverrideInput = z.infer<typeof upsertOverrideSchema>;

export const revokeOverrideSchema = z.object({ id: uuid, reason: z.string().min(5).max(2000) });
export type RevokeOverrideInput = z.infer<typeof revokeOverrideSchema>;

export const upsertSubscriptionSchema = z.object({
  tenantId: uuid,
  planId: uuid,
  programmeId: uuid.nullable().optional(),
  billingInterval: z.enum(BILLING_INTERVALS).default("monthly"),
  status: z.string().min(2).max(40).default("active"),
  reason: z.string().min(5).max(2000),
});
export type UpsertSubscriptionInput = z.infer<typeof upsertSubscriptionSchema>;

export const grantCommercialAdminSchema = z.object({
  userId: uuid,
  notes: z.string().max(500).optional(),
});
export type GrantCommercialAdminInput = z.infer<typeof grantCommercialAdminSchema>;

export const revokeCommercialAdminSchema = z.object({ userId: uuid });
export type RevokeCommercialAdminInput = z.infer<typeof revokeCommercialAdminSchema>;

/* ------------------------------------------------------------------ reads */

export const resolveEntitlementSchema = z.object({
  tenantId: uuid,
  capabilityCode: z.string().min(2).max(80),
  propertyId: uuid.optional(),
});
export type ResolveEntitlementInput = z.infer<typeof resolveEntitlementSchema>;

export const listTenantEntitlementsSchema = z.object({ tenantId: uuid });
export type ListTenantEntitlementsInput = z.infer<typeof listTenantEntitlementsSchema>;

export const checkQuotaSchema = z.object({
  tenantId: uuid,
  quotaCode: z.string().min(2).max(80),
  propertyId: uuid.optional(),
});
export type CheckQuotaInput = z.infer<typeof checkQuotaSchema>;

export const listTenantUsageSchema = z.object({ tenantId: uuid });
export type ListTenantUsageInput = z.infer<typeof listTenantUsageSchema>;

export const listAuditLogSchema = z.object({
  tenantId: uuid.optional(),
  entityType: z.string().max(60).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type ListAuditLogInput = z.infer<typeof listAuditLogSchema>;

export const listOverridesSchema = z.object({
  tenantId: uuid.optional(),
  scopeType: z.enum(OVERRIDE_SCOPE_TYPES).optional(),
});
export type ListOverridesInput = z.infer<typeof listOverridesSchema>;

export const listPropertyClassificationsSchema = z.object({ tenantId: uuid.optional() });
export type ListPropertyClassificationsInput = z.infer<typeof listPropertyClassificationsSchema>;

export interface QuotaStatus {
  quotaCode: string;
  unit: QuotaUnit;
  limitValue: number;
  usedValue: number;
  period: QuotaPeriod;
  periodStart: string;
  periodEnd: string;
  state: UsageState;
  overageBehavior: OverageBehavior;
  warningThresholdPct: number;
  nearLimitThresholdPct: number;
  hasOverride: boolean;
}

/** JSON-representable value — used instead of `unknown`/`any` so server-fn return types stay verifiably serializable. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EntitlementResult {
  capabilityCode: string;
  capabilityStatus: CapabilityStatus | "unknown";
  state: EntitlementState;
  source: "override" | "programme" | "plan" | "default";
  planCode: PlanCode | null;
  programmeCode: string | null;
  config: Record<string, JsonValue>;
  quota: QuotaStatus | null;
}

/* =========================================================================
 * P02 — Commercialization Operating System (browser-safe contracts).
 *
 * The commercial LIFECYCLE/TRANSACTION layer on top of P01's policy layer
 * above: billing accounts, agreements, subscription lifecycle actions,
 * invoices/lines, payments. See migration
 * 0040_p02_commercialization_lifecycle.sql for the schema these mirror.
 * ========================================================================= */

export const SUBSCRIPTION_STATUSES = [
  "draft",
  "pending_activation",
  "active",
  "trial",
  "past_due",
  "suspended",
  "cancelled",
  "expired",
  "renewing",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const AGREEMENT_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "active",
  "superseded",
  "cancelled",
] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

export const INVOICE_STATUSES = [
  "draft",
  "issued",
  "partially_paid",
  "paid",
  "void",
  "cancelled",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_LINE_KINDS = [
  "base_subscription",
  "additional_property",
  "implementation",
  "add_on",
  "discount",
  "tax",
  "other",
] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export const PAYMENT_METHODS = [
  "manual_bank_transfer",
  "manual_mobile_money",
  "manual_cash",
  "manual_cheque",
  "card",
  "gateway",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "refunded", "voided"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const COMMERCIAL_CUSTOMER_STATUSES = [
  "prospect",
  "active",
  "past_due",
  "suspended",
  "cancelled",
] as const;
export type CommercialCustomerStatus = (typeof COMMERCIAL_CUSTOMER_STATUSES)[number];

export const PRORATION_POLICIES = ["full_period", "prorated", "next_period"] as const;
export type ProrationPolicy = (typeof PRORATION_POLICIES)[number];

export const RENEWAL_STATUSES = ["not_due", "due", "renewed", "declined"] as const;
export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];

/* --------------------------------------------------------- billing account */

export const upsertBillingAccountSchema = z.object({
  tenantId: uuid,
  currency: z.string().min(3).max(8).default("TZS"),
  billingContactName: z.string().max(200).optional(),
  billingContactEmail: z.string().email().optional(),
  billingContactPhone: z.string().max(40).optional(),
  billingAddress: z.string().max(400).optional(),
  taxId: z.string().max(80).optional(),
  paymentMethodReference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});
export type UpsertBillingAccountInput = z.infer<typeof upsertBillingAccountSchema>;

/* ------------------------------------------------------------- agreements */

export const createAgreementSchema = z.object({
  tenantId: uuid,
  planId: uuid,
  programmeId: uuid.optional(),
  billingInterval: z.enum(BILLING_INTERVALS).default("monthly"),
  discountPct: z.number().min(0).max(100).optional(),
  discountReason: z.string().max(500).optional(),
  requiresPaymentBeforeActivation: z.boolean().default(true),
  effectiveFrom: z.string().datetime().optional(),
  agreedTerms: z.string().max(10000).optional(),
  renewedFromAgreementId: uuid.optional(),
});
export type CreateAgreementInput = z.infer<typeof createAgreementSchema>;

export const approveAgreementSchema = z.object({
  agreementId: uuid,
  reason: z.string().min(3).max(2000).optional(),
});
export type ApproveAgreementInput = z.infer<typeof approveAgreementSchema>;

export const cancelAgreementSchema = z.object({
  agreementId: uuid,
  reason: z.string().min(5).max(2000),
});
export type CancelAgreementInput = z.infer<typeof cancelAgreementSchema>;

export const listAgreementsSchema = z.object({ tenantId: uuid.optional() });
export type ListAgreementsInput = z.infer<typeof listAgreementsSchema>;

/* --------------------------------------------------- subscription lifecycle */

export const activateSubscriptionSchema = z.object({
  agreementId: uuid,
  reason: z.string().max(2000).optional(),
});
export type ActivateSubscriptionInput = z.infer<typeof activateSubscriptionSchema>;

export const cancelSubscriptionSchema = z.object({
  tenantId: uuid,
  reason: z.string().min(5).max(2000),
});
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;

export const suspendSubscriptionSchema = z.object({
  tenantId: uuid,
  reason: z.string().min(5).max(2000),
});
export type SuspendSubscriptionInput = z.infer<typeof suspendSubscriptionSchema>;

export const reactivateSubscriptionSchema = z.object({
  tenantId: uuid,
  reason: z.string().min(5).max(2000),
});
export type ReactivateSubscriptionInput = z.infer<typeof reactivateSubscriptionSchema>;

export const renewSubscriptionSchema = z.object({
  tenantId: uuid,
  keepDiscount: z.boolean().default(false),
  reason: z.string().max(2000).optional(),
});
export type RenewSubscriptionInput = z.infer<typeof renewSubscriptionSchema>;

/* ------------------------------------------------------------------ billing */

export const generateInvoiceSchema = z.object({
  tenantId: uuid,
  billingPeriodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  billingPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  includeImplementationFee: z.boolean().default(false),
});
export type GenerateInvoiceInput = z.infer<typeof generateInvoiceSchema>;

export const issueInvoiceSchema = z.object({
  invoiceId: uuid,
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;

export const voidInvoiceSchema = z.object({
  invoiceId: uuid,
  reason: z.string().min(5).max(2000),
});
export type VoidInvoiceInput = z.infer<typeof voidInvoiceSchema>;

export const listInvoicesSchema = z.object({
  tenantId: uuid.optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
});
export type ListInvoicesInput = z.infer<typeof listInvoicesSchema>;

export const recordPaymentSchema = z.object({
  invoiceId: uuid,
  method: z.enum(PAYMENT_METHODS),
  amount: z.number().positive(),
  currency: z.string().min(3).max(8).default("TZS"),
  providerReference: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
  receivedAt: z.string().datetime().optional(),
  idempotencyKey: z.string().min(6).max(200),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const listPaymentsSchema = z.object({
  tenantId: uuid.optional(),
  invoiceId: uuid.optional(),
});
export type ListPaymentsInput = z.infer<typeof listPaymentsSchema>;
