/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P01 — commercial catalogue reads + admin CRUD.
 *
 * Catalogue/definition tables (plans, capabilities, programmes,
 * entitlements, pricing, property policies, quota definitions) are
 * readable by any authenticated caller at the database layer (RLS) — the
 * entitlement resolver and pricing surfaces must work under any user's own
 * session, the same way a pricing/feature comparison page would. Every
 * WRITE here is gated by assertCommercialAdmin AND backed by the matching
 * RLS policy, so a tenant admin cannot reach these through a direct API
 * call either.
 */
import { assertCommercialAdmin, isCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import type {
  GrantCommercialAdminInput,
  RevokeCommercialAdminInput,
  RevokeOverrideInput,
  UpsertCapabilityInput,
  UpsertOverrideInput,
  UpsertPlanEntitlementInput,
  UpsertPlanInput,
  UpsertPricingInput,
  UpsertProgrammeEntitlementInput,
  UpsertProgrammeInput,
  UpsertPropertyPolicyInput,
  UpsertQuotaDefinitionInput,
  UpsertSubscriptionInput,
} from "./contracts";

type Sb = any;

/* ------------------------------------------------------------------ reads */

export async function listPlans(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_plans")
    .select("id, code, name, description, status, sort_order")
    .order("sort_order");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listCapabilities(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_capabilities")
    .select("id, code, name, description, category, status, sort_order")
    .order("sort_order");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listProgrammes(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_programmes")
    .select(
      "id, code, name, description, status, eligibility, start_date, end_date, support_sla_override, contract_reference, notes",
    )
    .order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listPlanEntitlements(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_plan_entitlements")
    .select(
      "id, plan_id, capability_id, state, config, effective_from, effective_until, commercial_plans(code), commercial_capabilities(code, name)",
    )
    .order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listProgrammeEntitlements(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_programme_entitlements")
    .select(
      "id, programme_id, capability_id, state, config, commercial_programmes(code), commercial_capabilities(code, name)",
    )
    .order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listPricing(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_pricing")
    .select(
      "id, plan_id, programme_id, currency, monthly_price, annual_price, additional_property_price, implementation_fee, billing_interval, tax_treatment, trial_days, discount_pct, status, effective_from, effective_until, notes, commercial_plans(code), commercial_programmes(code)",
    )
    .order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listPropertyPolicies(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_property_policies")
    .select(
      "id, plan_id, programme_id, included_properties, additional_property_price, property_limit, requires_approval_above, enterprise_treatment, status, effective_from, effective_until, notes, commercial_plans(code), commercial_programmes(code)",
    )
    .order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listQuotaDefinitions(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_quota_definitions")
    .select(
      "id, code, capability_id, plan_id, programme_id, unit, limit_value, period, scope, warning_threshold_pct, near_limit_threshold_pct, overage_behavior, active, effective_from, effective_until, commercial_plans(code), commercial_programmes(code), commercial_capabilities(code)",
    )
    .order("code");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listOverrides(sb: Sb, filter: { tenantId?: string; scopeType?: string }) {
  let q = sb
    .from("commercial_overrides")
    .select(
      "id, scope_type, scope_id, tenant_id, override_type, payload, reason, approval_reference, status, created_by, created_at, effective_from, effective_until, revoked_by, revoked_at",
    )
    .order("created_at", { ascending: false });
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  if (filter.scopeType) q = q.eq("scope_type", filter.scopeType);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * §31, §52 — every restaurant tenant, for the commercial customer picker
 * and search. Requires commercial admin (see migration 0041 — a
 * commercial admin's read access to `restaurant_tenants` is scoped
 * narrowly to this identity table, not the shared tenant-membership check
 * every operational table uses).
 */
export async function listTenants(sb: Sb) {
  const { data, error } = await sb
    .from("restaurant_tenants")
    .select("id, name, slug")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listSubscriptions(sb: Sb) {
  const { data, error } = await sb
    .from("restaurant_subscriptions")
    .select(
      "id, tenant_id, plan, status, seats, plan_id, programme_id, billing_interval, trial_ends_at, current_period_end, agreement_id, renewal_date, renewal_status, activated_at, restaurant_tenants(name, slug), commercial_plans(code, name), commercial_programmes(code, name), commercial_agreements!restaurant_subscriptions_agreement_id_fkey(monthly_price, annual_price, currency)",
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listPropertyClassifications(sb: Sb, filter: { tenantId?: string }) {
  let q = sb
    .from("commercial_property_classifications")
    .select(
      "id, tenant_id, property_id, subscription_id, plan_id, programme_id, classification, chargeable, price_applied, currency, property_sequence, effective_from, decided_by, decided_at, notes, restaurant_properties(name, slug), restaurant_tenants(name, slug), commercial_plans(code)",
    )
    .order("decided_at", { ascending: false });
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listAuditLog(
  sb: Sb,
  filter: { tenantId?: string; entityType?: string; limit: number },
) {
  let q = sb
    .from("commercial_audit_log")
    .select(
      "id, actor_id, action, entity_type, entity_id, tenant_id, before, after, reason, reference, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(filter.limit);
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  if (filter.entityType) q = q.eq("entity_type", filter.entityType);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listCommercialAdministrators(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_administrators")
    .select("id, user_id, status, granted_by, granted_at, revoked_by, revoked_at, notes")
    .order("granted_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Whether the calling user is a commercial admin — safe to expose to any authenticated caller (it only describes themselves). */
export async function whoAmI(sb: Sb, userId: string) {
  return { userId, commercialAdmin: await isCommercialAdmin(sb, userId) };
}

/* -------------------------------------------------------------- plan CRUD */

export async function upsertPlan(sb: Sb, userId: string, input: UpsertPlanInput) {
  await assertCommercialAdmin(sb, userId);
  const row = {
    code: input.code,
    name: input.name,
    description: input.description ?? null,
    status: input.status,
    sort_order: input.sortOrder,
  };
  const before = input.id
    ? (await sb.from("commercial_plans").select("*").eq("id", input.id).maybeSingle()).data
    : null;
  const q = input.id
    ? sb.from("commercial_plans").update(row).eq("id", input.id)
    : sb.from("commercial_plans").insert(row);
  const { data, error } = await q.select("id, code, name, status, sort_order").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "plan.update" : "plan.create",
    entityType: "commercial_plans",
    entityId: data.id,
    before,
    after: data,
  });
  return data;
}

export async function upsertCapability(sb: Sb, userId: string, input: UpsertCapabilityInput) {
  await assertCommercialAdmin(sb, userId);
  const row = {
    code: input.code,
    name: input.name,
    description: input.description ?? null,
    category: input.category,
    status: input.status,
    sort_order: input.sortOrder,
  };
  const before = input.id
    ? (await sb.from("commercial_capabilities").select("*").eq("id", input.id).maybeSingle()).data
    : null;
  const q = input.id
    ? sb.from("commercial_capabilities").update(row).eq("id", input.id)
    : sb.from("commercial_capabilities").insert(row);
  const { data, error } = await q.select("id, code, name, status").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "capability.update" : "capability.create",
    entityType: "commercial_capabilities",
    entityId: data.id,
    before,
    after: data,
  });
  return data;
}

export async function upsertProgramme(sb: Sb, userId: string, input: UpsertProgrammeInput) {
  await assertCommercialAdmin(sb, userId);
  const row = {
    code: input.code,
    name: input.name,
    description: input.description ?? null,
    status: input.status,
    eligibility: input.eligibility,
    start_date: input.startDate ?? null,
    end_date: input.endDate ?? null,
    support_sla_override: input.supportSlaOverride ?? null,
    contract_reference: input.contractReference ?? null,
    notes: input.notes ?? null,
  };
  const before = input.id
    ? (await sb.from("commercial_programmes").select("*").eq("id", input.id).maybeSingle()).data
    : null;
  const q = input.id
    ? sb.from("commercial_programmes").update(row).eq("id", input.id)
    : sb.from("commercial_programmes").insert(row);
  const { data, error } = await q.select("id, code, name, status").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "programme.update" : "programme.create",
    entityType: "commercial_programmes",
    entityId: data.id,
    before,
    after: data,
  });
  return data;
}

export async function upsertPlanEntitlement(
  sb: Sb,
  userId: string,
  input: UpsertPlanEntitlementInput,
) {
  await assertCommercialAdmin(sb, userId);
  const row = {
    plan_id: input.planId,
    capability_id: input.capabilityId,
    state: input.state,
    config: input.config,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_until: input.effectiveUntil ?? null,
  };
  const before = input.id
    ? (await sb.from("commercial_plan_entitlements").select("*").eq("id", input.id).maybeSingle())
        .data
    : null;
  const q = input.id
    ? sb.from("commercial_plan_entitlements").update(row).eq("id", input.id)
    : sb.from("commercial_plan_entitlements").insert(row);
  const { data, error } = await q.select("id, plan_id, capability_id, state").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "plan_entitlement.update" : "plan_entitlement.create",
    entityType: "commercial_plan_entitlements",
    entityId: data.id,
    before,
    after: data,
  });
  return data;
}

export async function upsertProgrammeEntitlement(
  sb: Sb,
  userId: string,
  input: UpsertProgrammeEntitlementInput,
) {
  await assertCommercialAdmin(sb, userId);
  const row = {
    programme_id: input.programmeId,
    capability_id: input.capabilityId,
    state: input.state,
    config: input.config,
  };
  const before = input.id
    ? (
        await sb
          .from("commercial_programme_entitlements")
          .select("*")
          .eq("id", input.id)
          .maybeSingle()
      ).data
    : null;
  const q = input.id
    ? sb.from("commercial_programme_entitlements").update(row).eq("id", input.id)
    : sb.from("commercial_programme_entitlements").insert(row);
  const { data, error } = await q.select("id, programme_id, capability_id, state").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "programme_entitlement.update" : "programme_entitlement.create",
    entityType: "commercial_programme_entitlements",
    entityId: data.id,
    before,
    after: data,
  });
  return data;
}

export async function upsertPricing(sb: Sb, userId: string, input: UpsertPricingInput) {
  await assertCommercialAdmin(sb, userId);
  const row = {
    plan_id: input.planId,
    programme_id: input.programmeId ?? null,
    currency: input.currency,
    monthly_price: input.monthlyPrice ?? null,
    annual_price: input.annualPrice ?? null,
    additional_property_price: input.additionalPropertyPrice ?? null,
    implementation_fee: input.implementationFee ?? null,
    billing_interval: input.billingInterval,
    tax_treatment: input.taxTreatment,
    trial_days: input.trialDays,
    discount_pct: input.discountPct ?? null,
    status: input.status,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_until: input.effectiveUntil ?? null,
    notes: input.notes ?? null,
  };
  const before = input.id
    ? (await sb.from("commercial_pricing").select("*").eq("id", input.id).maybeSingle()).data
    : null;
  const q = input.id
    ? sb.from("commercial_pricing").update(row).eq("id", input.id)
    : sb.from("commercial_pricing").insert(row);
  const { data, error } = await q.select("id, plan_id, monthly_price, annual_price").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "pricing.update" : "pricing.create",
    entityType: "commercial_pricing",
    entityId: data.id,
    before,
    after: data,
    reason: "Admin pricing change",
  });
  return data;
}

export async function upsertPropertyPolicy(
  sb: Sb,
  userId: string,
  input: UpsertPropertyPolicyInput,
) {
  await assertCommercialAdmin(sb, userId);
  const row = {
    plan_id: input.planId,
    programme_id: input.programmeId ?? null,
    included_properties: input.includedProperties,
    additional_property_price: input.additionalPropertyPrice ?? null,
    property_limit: input.propertyLimit ?? null,
    requires_approval_above: input.requiresApprovalAbove ?? null,
    enterprise_treatment: input.enterpriseTreatment,
    status: input.status,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_until: input.effectiveUntil ?? null,
    notes: input.notes ?? null,
  };
  const before = input.id
    ? (await sb.from("commercial_property_policies").select("*").eq("id", input.id).maybeSingle())
        .data
    : null;
  const q = input.id
    ? sb.from("commercial_property_policies").update(row).eq("id", input.id)
    : sb.from("commercial_property_policies").insert(row);
  const { data, error } = await q.select("id, plan_id, included_properties").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "property_policy.update" : "property_policy.create",
    entityType: "commercial_property_policies",
    entityId: data.id,
    before,
    after: data,
  });
  return data;
}

export async function upsertQuotaDefinition(
  sb: Sb,
  userId: string,
  input: UpsertQuotaDefinitionInput,
) {
  await assertCommercialAdmin(sb, userId);
  const row = {
    code: input.code,
    capability_id: input.capabilityId ?? null,
    plan_id: input.planId ?? null,
    programme_id: input.programmeId ?? null,
    unit: input.unit,
    limit_value: input.limitValue,
    period: input.period,
    scope: input.scope,
    warning_threshold_pct: input.warningThresholdPct,
    near_limit_threshold_pct: input.nearLimitThresholdPct,
    overage_behavior: input.overageBehavior,
    active: input.active,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_until: input.effectiveUntil ?? null,
  };
  const before = input.id
    ? (await sb.from("commercial_quota_definitions").select("*").eq("id", input.id).maybeSingle())
        .data
    : null;
  const q = input.id
    ? sb.from("commercial_quota_definitions").update(row).eq("id", input.id)
    : sb.from("commercial_quota_definitions").insert(row);
  const { data, error } = await q.select("id, code, limit_value, period").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "quota_definition.update" : "quota_definition.create",
    entityType: "commercial_quota_definitions",
    entityId: data.id,
    before,
    after: data,
  });
  return data;
}

export async function upsertOverride(sb: Sb, userId: string, input: UpsertOverrideInput) {
  await assertCommercialAdmin(sb, userId);
  const row = {
    scope_type: input.scopeType,
    scope_id: input.scopeId ?? null,
    tenant_id: input.tenantId ?? null,
    override_type: input.overrideType,
    payload: input.payload,
    reason: input.reason,
    approval_reference: input.approvalReference ?? null,
    status: "active",
    created_by: userId,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_until: input.effectiveUntil ?? null,
  };
  const before = input.id
    ? (await sb.from("commercial_overrides").select("*").eq("id", input.id).maybeSingle()).data
    : null;
  const q = input.id
    ? sb.from("commercial_overrides").update(row).eq("id", input.id)
    : sb.from("commercial_overrides").insert(row);
  const { data, error } = await q.select("id, scope_type, override_type, status").single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: input.id ? "override.update" : "override.create",
    entityType: "commercial_overrides",
    entityId: data.id,
    tenantId: input.tenantId ?? null,
    before,
    after: data,
    reason: input.reason,
    reference: input.approvalReference ?? null,
  });
  return data;
}

export async function revokeOverride(sb: Sb, userId: string, input: RevokeOverrideInput) {
  await assertCommercialAdmin(sb, userId);
  const { data: before } = await sb
    .from("commercial_overrides")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  const { data, error } = await sb
    .from("commercial_overrides")
    .update({ status: "revoked", revoked_by: userId, revoked_at: new Date().toISOString() })
    .eq("id", input.id)
    .select("id, status")
    .single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "override.revoke",
    entityType: "commercial_overrides",
    entityId: input.id,
    tenantId: before?.tenant_id ?? null,
    before,
    after: data,
    reason: input.reason,
  });
  return data;
}

export async function upsertSubscription(sb: Sb, userId: string, input: UpsertSubscriptionInput) {
  await assertCommercialAdmin(sb, userId);
  const { data: existing } = await sb
    .from("restaurant_subscriptions")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  const row = {
    tenant_id: input.tenantId,
    plan_id: input.planId,
    programme_id: input.programmeId ?? null,
    billing_interval: input.billingInterval,
    status: input.status,
  };
  const q = existing
    ? sb.from("restaurant_subscriptions").update(row).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_subscriptions").insert({ ...row, plan: "managed", seats: 5 });
  const { data, error } = await q
    .select("id, tenant_id, plan_id, programme_id, billing_interval, status")
    .single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: existing ? "subscription.update" : "subscription.create",
    entityType: "restaurant_subscriptions",
    entityId: data.id,
    tenantId: input.tenantId,
    before: existing ?? null,
    after: data,
    reason: input.reason,
  });
  return data;
}

/* ----------------------------------------------------- commercial admins */

export async function grantCommercialAdmin(
  sb: Sb,
  userId: string,
  input: GrantCommercialAdminInput,
) {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb
    .from("commercial_administrators")
    .upsert(
      { user_id: input.userId, status: "active", granted_by: userId, notes: input.notes ?? null },
      { onConflict: "user_id" },
    )
    .select("id, user_id, status")
    .single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "commercial_administrator.grant",
    entityType: "commercial_administrators",
    entityId: data.id,
    after: data,
  });
  return data;
}

export async function revokeCommercialAdmin(
  sb: Sb,
  userId: string,
  input: RevokeCommercialAdminInput,
) {
  await assertCommercialAdmin(sb, userId);
  const { data, error } = await sb
    .from("commercial_administrators")
    .update({ status: "revoked", revoked_by: userId, revoked_at: new Date().toISOString() })
    .eq("user_id", input.userId)
    .select("id, user_id, status")
    .single();
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "commercial_administrator.revoke",
    entityType: "commercial_administrators",
    entityId: data.id,
    after: data,
  });
  return data;
}
