/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P02 — Commercial Agreements: the signed-terms snapshot.
 *
 * `createAgreement` is the ONE place a customer's contractual price is
 * fixed. It copies the live `commercial_pricing` row for the chosen
 * plan/programme onto the agreement at creation time — every number the
 * agreement will ever charge lives on the agreement row itself from that
 * point on. A commercial admin editing the pricing catalogue afterward
 * (§6, §44) changes what a NEW agreement would copy; it can never rewrite
 * an already-created one, because nothing here re-reads commercial_pricing
 * after this function returns.
 */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import type {
  ApproveAgreementInput,
  CancelAgreementInput,
  CreateAgreementInput,
} from "./contracts";

type Sb = any;

async function nextContractReference(sb: Sb, tenantId: string): Promise<string> {
  const { data, error } = await sb.rpc("restaurant_next_document_number", {
    _tenant: tenantId,
    _doc_type: "commercial_agreement",
    _prefix: "AGR",
  });
  if (error || !data) return `AGR-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
  return String(data);
}

async function loadActivePricing(sb: Sb, planId: string, programmeId: string | null) {
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from("commercial_pricing")
    .select(
      "monthly_price, annual_price, additional_property_price, implementation_fee, currency, tax_treatment, tax_rate_pct, programme_id",
    )
    .eq("plan_id", planId)
    .eq("status", "active")
    .lte("effective_from", nowIso)
    .or(`effective_until.is.null,effective_until.gt.${nowIso}`);
  if (error) throw new Error(error.message);
  const rows: any[] = data ?? [];
  if (rows.length === 0) return null;
  // Programme-specific pricing (if configured) wins over the plan's
  // programme-agnostic row — the same precedence property-classification
  // already uses for property policy.
  const withProgramme = programmeId ? rows.find((r) => r.programme_id === programmeId) : null;
  return withProgramme ?? rows.find((r) => r.programme_id === null) ?? rows[0];
}

export async function createAgreement(sb: Sb, userId: string, input: CreateAgreementInput) {
  await assertCommercialAdmin(sb, userId);

  const pricing = await loadActivePricing(sb, input.planId, input.programmeId ?? null);
  // Never fabricate a price: an Enterprise-style plan with no fixed catalog
  // price yields a draft agreement with null prices, which billing.server.ts
  // refuses to invoice until a commercial admin sets one explicitly (the
  // same "never silently charge" discipline property-classification.server.ts
  // already applies).
  const discountAmount =
    input.discountPct != null && pricing?.monthly_price != null
      ? Math.round(((pricing.monthly_price * input.discountPct) / 100) * 100) / 100
      : null;

  const reference = await nextContractReference(sb, input.tenantId);

  const { data, error } = await sb
    .from("commercial_agreements")
    .insert({
      tenant_id: input.tenantId,
      contract_reference: reference,
      plan_id: input.planId,
      programme_id: input.programmeId ?? null,
      status: "draft",
      billing_interval: input.billingInterval,
      currency: pricing?.currency ?? "TZS",
      monthly_price: pricing?.monthly_price ?? null,
      annual_price: pricing?.annual_price ?? null,
      additional_property_price: pricing?.additional_property_price ?? null,
      implementation_fee: pricing?.implementation_fee ?? null,
      discount_pct: input.discountPct ?? null,
      discount_amount: discountAmount,
      discount_reason: input.discountReason ?? null,
      tax_treatment: pricing?.tax_treatment ?? "exclusive",
      tax_rate_pct: pricing?.tax_rate_pct ?? null,
      requires_payment_before_activation: input.requiresPaymentBeforeActivation,
      effective_from: input.effectiveFrom ?? new Date().toISOString(),
      agreed_terms: input.agreedTerms ?? null,
      renewed_from_agreement_id: input.renewedFromAgreementId ?? null,
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "agreement.create",
    entityType: "commercial_agreements",
    entityId: data.id,
    tenantId: input.tenantId,
    after: data,
    reference,
  });
  return data;
}

/** draft/submitted → approved. Approval is a distinct, audited step from creation — a draft can be discarded freely, an approved agreement cannot. */
export async function approveAgreement(sb: Sb, userId: string, input: ApproveAgreementInput) {
  await assertCommercialAdmin(sb, userId);
  const { data: existing, error: readErr } = await sb
    .from("commercial_agreements")
    .select("*")
    .eq("id", input.agreementId)
    .single();
  if (readErr) throw new Error(readErr.message);
  if (!["draft", "submitted"].includes(existing.status)) {
    throw new Error(`Cannot approve an agreement in status "${existing.status}".`);
  }
  const { data, error } = await sb
    .from("commercial_agreements")
    .update({ status: "approved", approved_by: userId, approved_at: new Date().toISOString() })
    .eq("id", input.agreementId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "agreement.approve",
    entityType: "commercial_agreements",
    entityId: data.id,
    tenantId: data.tenant_id,
    before: existing,
    after: data,
    reason: input.reason ?? null,
  });
  return data;
}

export async function cancelAgreement(sb: Sb, userId: string, input: CancelAgreementInput) {
  await assertCommercialAdmin(sb, userId);
  const { data: existing, error: readErr } = await sb
    .from("commercial_agreements")
    .select("*")
    .eq("id", input.agreementId)
    .single();
  if (readErr) throw new Error(readErr.message);
  if (existing.status === "cancelled") return existing;

  const { data, error } = await sb
    .from("commercial_agreements")
    .update({
      status: "cancelled",
      cancelled_by: userId,
      cancelled_at: new Date().toISOString(),
      cancellation_reason: input.reason,
    })
    .eq("id", input.agreementId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "agreement.cancel",
    entityType: "commercial_agreements",
    entityId: data.id,
    tenantId: data.tenant_id,
    before: existing,
    after: data,
    reason: input.reason,
  });
  return data;
}

export async function listAgreements(sb: Sb, filter: { tenantId?: string }) {
  let q = sb
    .from("commercial_agreements")
    .select(
      "*, restaurant_tenants(name, slug), commercial_plans(code, name), commercial_programmes(code, name)",
    )
    .order("created_at", { ascending: false });
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getAgreement(sb: Sb, agreementId: string) {
  const { data, error } = await sb
    .from("commercial_agreements")
    .select("*")
    .eq("id", agreementId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}
