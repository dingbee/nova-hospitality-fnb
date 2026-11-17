/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase rows are validated at this boundary. */
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { incrementUsage } from "@/modules/commercial/quota.server";

type Db = any;
type Campaign = {
  id: string;
  tenant_id: string;
  property_id: string;
  template_id: string;
  status: string;
  trigger_type: "scheduled" | "event";
  scheduled_at: string | null;
  daily_cap: number | null;
  total_cap: number | null;
};
type Template = {
  id: string;
  tenant_id: string;
  property_id: string | null;
  category: "marketing" | "utility" | "authentication";
  status: string;
  template_name: string;
  language: string;
};

export class WhatsAppCampaignGovernanceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WhatsAppCampaignGovernanceError";
  }
}

/** Checks commercial entitlement and the persisted approval state before a campaign can be prepared. */
export async function assertWhatsAppCampaignReady(
  admin: Db,
  tenantId: string,
  propertyId: string,
  campaignId: string,
  now = new Date(),
) {
  await assertEntitled(admin, tenantId, "whatsapp_campaigns", { propertyId });
  const { data: campaign, error: campaignError } = await admin
    .from("wa_campaigns")
    .select(
      "id, tenant_id, property_id, template_id, status, trigger_type, scheduled_at, daily_cap, total_cap",
    )
    .eq("id", campaignId)
    .eq("tenant_id", tenantId)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (campaignError || !campaign) throw new WhatsAppCampaignGovernanceError("campaign_not_found");
  const row = campaign as Campaign;
  if (!["ready", "scheduled", "running"].includes(row.status))
    throw new WhatsAppCampaignGovernanceError("campaign_not_dispatchable");
  if (row.trigger_type === "scheduled" && (!row.scheduled_at || new Date(row.scheduled_at) > now))
    throw new WhatsAppCampaignGovernanceError("campaign_not_due");

  const { data: template, error: templateError } = await admin
    .from("wa_message_templates")
    .select("id, tenant_id, property_id, category, status, template_name, language")
    .eq("id", row.template_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (templateError || !template) throw new WhatsAppCampaignGovernanceError("template_not_found");
  const approved = template as Template;
  if (approved.status !== "approved")
    throw new WhatsAppCampaignGovernanceError("template_not_approved");
  if (approved.property_id && approved.property_id !== propertyId)
    throw new WhatsAppCampaignGovernanceError("template_property_scope_mismatch");
  return { campaign: row, template: approved };
}

/**
 * Persists an audience decision only. It never sends a Meta message.
 * Marketing recipients are suppressed unless the latest immutable WCE-05 consent is granted.
 */
export async function prepareWhatsAppCampaignRecipient(
  admin: Db,
  input: { tenantId: string; propertyId: string; campaignId: string; guestCustomerId: string },
) {
  const { campaign } = await assertWhatsAppCampaignReady(
    admin,
    input.tenantId,
    input.propertyId,
    input.campaignId,
  );
  const { data, error } = await admin.rpc("wa_prepare_campaign_recipient", {
    _tenant_id: input.tenantId,
    _property_id: input.propertyId,
    _campaign_id: campaign.id,
    _guest_customer_id: input.guestCustomerId,
    _idempotency_key: "campaign:" + campaign.id + ":guest:" + input.guestCustomerId,
  });
  if (error) throw new WhatsAppCampaignGovernanceError("recipient_preparation_failed");
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.recipient_id) throw new WhatsAppCampaignGovernanceError("recipient_persistence_failed");
  return {
    duplicate: false as const,
    recipientId: String(row.recipient_id),
    state: String(row.state),
    suppressionReason: row.suppression_reason ? String(row.suppression_reason) : null,
  };
}

/** Resolves the current effective Meta market/category rate without caching or rewriting historical rates. */
export async function resolveEffectiveMetaMessageRate(
  admin: Db,
  marketCode: string,
  category: "marketing" | "utility" | "authentication" | "service",
  now = new Date(),
) {
  const timestamp = now.toISOString();
  const { data, error } = await admin
    .from("wa_meta_message_rates")
    .select("id, market_code, category, currency, unit_price, effective_from, effective_until")
    .eq("market_code", marketCode)
    .eq("category", category)
    .eq("active", true)
    .lte("effective_from", timestamp)
    .or("effective_until.is.null,effective_until.gt." + timestamp)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new WhatsAppCampaignGovernanceError("meta_rate_lookup_failed");
  if (!data) throw new WhatsAppCampaignGovernanceError("meta_rate_not_configured");
  return {
    id: String(data.id),
    marketCode: String(data.market_code),
    category: data.category as typeof category,
    currency: String(data.currency),
    unitPrice: Number(data.unit_price),
    effectiveFrom: String(data.effective_from),
    effectiveUntil: data.effective_until ? String(data.effective_until) : null,
  };
}

/** Records a cost component against an immutable rate snapshot; provider dispatch is deliberately separate. */
export async function recordWhatsAppCampaignUsage(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    campaignId?: string | null;
    guestCustomerId?: string | null;
    rateId?: string | null;
    usageComponent: "meta_provider" | "lexibite_commercial" | "ai";
    usageEvent: string;
    marketCode?: string | null;
    templateCategory?: "marketing" | "utility" | "authentication" | "service" | null;
    quantity: number;
    unitPrice: number;
    currency: string;
    idempotencyKey: string;
    providerReference?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  if (
    !Number.isFinite(input.quantity) ||
    input.quantity <= 0 ||
    !Number.isFinite(input.unitPrice) ||
    input.unitPrice < 0 ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    input.idempotencyKey.length < 6
  )
    throw new WhatsAppCampaignGovernanceError("usage_input_invalid");
  const amount = Number((input.quantity * input.unitPrice).toFixed(6));
  const rateSnapshot = {
    rateId: input.rateId ?? null,
    marketCode: input.marketCode ?? null,
    templateCategory: input.templateCategory ?? null,
    unitPrice: input.unitPrice,
    currency: input.currency,
  };
  const { data, error } = await admin
    .from("wa_campaign_usage_ledger")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId,
      campaign_id: input.campaignId ?? null,
      guest_customer_id: input.guestCustomerId ?? null,
      rate_id: input.rateId ?? null,
      usage_component: input.usageComponent,
      usage_event: input.usageEvent,
      market_code: input.marketCode ?? null,
      template_category: input.templateCategory ?? null,
      quantity: input.quantity,
      unit_price: input.unitPrice,
      amount,
      currency: input.currency,
      provider_reference: input.providerReference ?? null,
      idempotency_key: input.idempotencyKey,
      rate_snapshot: rateSnapshot,
      metadata: input.metadata ?? {},
    })
    .select("id, amount, currency")
    .single();
  if (error?.code === "23505") return { duplicate: true as const, amount: 0 };
  if (error || !data) throw new WhatsAppCampaignGovernanceError("usage_persistence_failed");
  return { duplicate: false as const, usageId: data.id, amount: Number(data.amount), currency: data.currency };
}

/** Uses the existing commercial quota engine; no parallel subscription or quota table is introduced. */
export async function accountWhatsAppCampaignMessageUsage(
  admin: Db,
  tenantId: string,
  propertyId: string,
  amount = 1,
) {
  return incrementUsage(admin, tenantId, "whatsapp_campaign_messages", { propertyId, amount });
}
