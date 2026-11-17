/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase rows are validated at this boundary. */
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { incrementUsage } from "@/modules/commercial/quota.server";
import { getIntegrationSecret } from "@/modules/api-platform/integrations.server";
import {
  createWabaMessageTemplate,
  listWabaMessageTemplates,
} from "./providers/meta-cloud-api.server";

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
  input: {
    tenantId: string;
    propertyId: string;
    campaignId: string;
    guestCustomerId: string;
    eventKey?: string | null;
  },
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
    _event_key: input.eventKey ?? null,
  });
  if (error) throw new WhatsAppCampaignGovernanceError("recipient_preparation_failed");
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.recipient_id) throw new WhatsAppCampaignGovernanceError("recipient_persistence_failed");
  return {
    duplicate: row.duplicate === true,
    recipientId: String(row.recipient_id),
    state: String(row.state),
    suppressionReason: row.suppression_reason ? String(row.suppression_reason) : null,
  };
}

function toMetaTemplateCategory(category: Template["category"]) {
  return category.toUpperCase() as "MARKETING" | "UTILITY" | "AUTHENTICATION";
}

async function resolveWhatsAppPropertyCredentials(
  admin: Db,
  tenantId: string,
  propertyId: string,
) {
  const { data: binding, error: bindingError } = await admin
    .from("wa_phone_number_bindings")
    .select("id, phone_number_id, integration_id, waba_id, status")
    .eq("tenant_id", tenantId)
    .eq("property_id", propertyId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (bindingError || !binding)
    throw new WhatsAppCampaignGovernanceError("whatsapp_property_binding_unavailable");

  const { data: integration, error: integrationError } = await admin
    .from("api_integrations")
    .select("id, status, config, provider, channel_key, integration_type")
    .eq("id", binding.integration_id)
    .eq("tenant_id", tenantId)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (
    integrationError ||
    !integration ||
    integration.status !== "active" ||
    integration.provider !== "meta-whatsapp" ||
    integration.channel_key !== "whatsapp" ||
    integration.integration_type !== "channel"
  ) throw new WhatsAppCampaignGovernanceError("whatsapp_property_integration_unavailable");

  const accessToken = await getIntegrationSecret(admin, tenantId, integration.id);
  if (!accessToken) throw new WhatsAppCampaignGovernanceError("whatsapp_property_credential_unavailable");
  return {
    accessToken,
    wabaId: String(integration.config?.wabaId ?? binding.waba_id),
    phoneNumberId: String(binding.phone_number_id),
    graphApiVersion: integration.config?.graphApiVersion,
  };
}

/** Submits one approved-by-tenant draft to Meta. The provider approval remains asynchronous. */
export async function submitWhatsAppMessageTemplateToMeta(
  admin: Db,
  input: { tenantId: string; propertyId: string; templateId: string },
) {
  const { data: template, error: templateError } = await admin
    .from("wa_message_templates")
    .select("id, tenant_id, property_id, template_name, language, category, status, components")
    .eq("id", input.templateId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (templateError || !template || (template.property_id && template.property_id !== input.propertyId))
    throw new WhatsAppCampaignGovernanceError("template_not_found");
  if (!["draft", "rejected"].includes(template.status))
    throw new WhatsAppCampaignGovernanceError("template_not_submittable");

  const credentials = await resolveWhatsAppPropertyCredentials(admin, input.tenantId, input.propertyId);
  const result = await createWabaMessageTemplate(
    credentials,
    {
      name: String(template.template_name),
      language: String(template.language),
      category: toMetaTemplateCategory(template.category as Template["category"]),
      components: Array.isArray(template.components) ? template.components : [],
    },
    { graphApiVersion: credentials.graphApiVersion },
  );
  const metaTemplateId = result.message_template_id ?? result.id;
  if (!metaTemplateId) throw new WhatsAppCampaignGovernanceError("meta_template_id_missing");
  const providerStatus = String(result.status ?? "PENDING").toUpperCase();
  const nextStatus = providerStatus === "APPROVED" ? "approved" : "submitted";
  const { error: updateError } = await admin
    .from("wa_message_templates")
    .update({
      meta_template_id: metaTemplateId,
      status: nextStatus,
      submitted_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
      rejection_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.templateId)
    .eq("tenant_id", input.tenantId);
  if (updateError) throw new WhatsAppCampaignGovernanceError("template_submission_state_failed");
  return { metaTemplateId, status: nextStatus };
}

/** Reconciles provider approval state into the local template registry without changing template content. */
export async function syncWhatsAppMessageTemplateStatuses(
  admin: Db,
  input: { tenantId: string; propertyId: string },
) {
  const credentials = await resolveWhatsAppPropertyCredentials(admin, input.tenantId, input.propertyId);
  const providerTemplates = await listWabaMessageTemplates(
    credentials,
    { graphApiVersion: credentials.graphApiVersion },
  );
  let updated = 0;
  for (const providerTemplate of providerTemplates) {
    if (!providerTemplate.id) continue;
    const providerStatus = providerTemplate.status.toUpperCase();
    const status =
      providerStatus === "APPROVED" ? "approved" :
      providerStatus === "REJECTED" ? "rejected" :
      providerStatus === "PAUSED" || providerStatus === "DISABLED" ? "paused" :
      providerStatus === "PENDING" ? "submitted" : null;
    if (!status) continue;
    const { error } = await admin
      .from("wa_message_templates")
      .update({
        status,
        rejection_reason: status === "rejected" ? "Meta rejected this template; review provider feedback." : null,
        reviewed_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", input.tenantId)
      .eq("property_id", input.propertyId)
      .eq("meta_template_id", providerTemplate.id);
    if (error) throw new WhatsAppCampaignGovernanceError("template_status_sync_failed");
    updated++;
  }
  return { providerTemplates: providerTemplates.length, updated };
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
  return {
    duplicate: false as const,
    usageId: data.id,
    amount: Number(data.amount),
    currency: data.currency,
  };
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
