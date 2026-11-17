/* eslint-disable @typescript-eslint/no-explicit-any -- privileged Supabase rows are validated at this boundary. */
import { assertEntitled } from "@/modules/commercial/resolver.server";
import { incrementUsage } from "@/modules/commercial/quota.server";
import { hasWhatsAppGuestMarketingConsent } from "./guest-crm.server";
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
  location_id: string;
  binding_id: string;
  market_code: string;
  template_id: string;
  status: string;
  trigger_type: "scheduled" | "event";
  event_key: string | null;
  audience_filter: Record<string, unknown>;
  scheduled_at: string | null;
  daily_cap: number | null;
  total_cap: number | null;
  message_components: Array<Record<string, unknown>>;
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
      "id, tenant_id, property_id, location_id, binding_id, market_code, template_id, status, trigger_type, event_key, audience_filter, scheduled_at, daily_cap, total_cap, message_components",
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
      .or("property_id.eq." + input.propertyId + ",property_id.is.null")
      .eq("meta_template_id", providerTemplate.id);
    if (error) throw new WhatsAppCampaignGovernanceError("template_status_sync_failed");
    updated++;
  }
  return { providerTemplates: providerTemplates.length, updated };
}

export async function createWhatsAppCampaign(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    locationId: string;
    bindingId: string;
    marketCode: string;
    templateId: string;
    name: string;
    triggerType: "scheduled" | "event";
    eventKey?: string | null;
    scheduledAt?: string | null;
    audienceFilter?: {
      preferredLanguage?: "en" | "sw";
      lastSeenAfter?: string;
      lastSeenBefore?: string;
    };
    messageComponents?: Array<Record<string, unknown>>;
    dailyCap?: number | null;
    totalCap?: number | null;
    createdBy?: string | null;
  },
) {
  await assertEntitled(admin, input.tenantId, "whatsapp_campaigns", { propertyId: input.propertyId });
  if (input.triggerType === "scheduled") {
    if (!input.scheduledAt || new Date(input.scheduledAt).getTime() <= Date.now())
      throw new WhatsAppCampaignGovernanceError("campaign_schedule_must_be_future");
  } else if (!input.eventKey?.trim()) {
    throw new WhatsAppCampaignGovernanceError("campaign_event_key_required");
  }
  if (input.dailyCap !== undefined && input.dailyCap !== null && input.dailyCap < 0)
    throw new WhatsAppCampaignGovernanceError("campaign_daily_cap_invalid");
  if (input.totalCap !== undefined && input.totalCap !== null && input.totalCap < 0)
    throw new WhatsAppCampaignGovernanceError("campaign_total_cap_invalid");

  if (!/^[A-Z]{2,3}$/.test(input.marketCode.toUpperCase()))
    throw new WhatsAppCampaignGovernanceError("campaign_market_code_invalid");

  const { data: binding, error: bindingError } = await admin
    .from("wa_phone_number_bindings")
    .select("id, status")
    .eq("id", input.bindingId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  if (bindingError || !binding || binding.status !== "active")
    throw new WhatsAppCampaignGovernanceError("campaign_binding_unavailable");

  const { data: template, error: templateError } = await admin
    .from("wa_message_templates")
    .select("id, status, property_id")
    .eq("id", input.templateId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (templateError || !template || template.status !== "approved")
    throw new WhatsAppCampaignGovernanceError("campaign_template_not_approved");
  if (template.property_id && template.property_id !== input.propertyId)
    throw new WhatsAppCampaignGovernanceError("campaign_template_scope_mismatch");

  const audienceFilter = input.audienceFilter ?? {};
  if (
    (audienceFilter.lastSeenAfter && Number.isNaN(Date.parse(audienceFilter.lastSeenAfter))) ||
    (audienceFilter.lastSeenBefore && Number.isNaN(Date.parse(audienceFilter.lastSeenBefore)))
  ) throw new WhatsAppCampaignGovernanceError("campaign_audience_filter_invalid");

  const { data, error } = await admin
    .from("wa_campaigns")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId,
      location_id: input.locationId,
      binding_id: input.bindingId,
      market_code: input.marketCode.toUpperCase(),
      template_id: input.templateId,
      name: input.name.trim(),
      trigger_type: input.triggerType,
      event_key: input.triggerType === "event" ? input.eventKey?.trim() : null,
      audience_filter: audienceFilter,
      message_components: input.messageComponents ?? [],
      status: "draft",
      scheduled_at: input.triggerType === "scheduled" ? input.scheduledAt : null,
      daily_cap: input.dailyCap ?? null,
      total_cap: input.totalCap ?? null,
      created_by: input.createdBy ?? null,
    })
    .select("id, status")
    .single();
  if (error || !data) throw new WhatsAppCampaignGovernanceError("campaign_create_failed");
  return { campaignId: String(data.id), status: String(data.status) };
}

export async function activateWhatsAppCampaign(
  admin: Db,
  input: { tenantId: string; propertyId: string; campaignId: string },
) {
  await assertEntitled(admin, input.tenantId, "whatsapp_campaigns", { propertyId: input.propertyId });
  const { data: campaign, error } = await admin
    .from("wa_campaigns")
    .select("id, status, trigger_type, scheduled_at, template_id")
    .eq("id", input.campaignId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .maybeSingle();
  if (error || !campaign) throw new WhatsAppCampaignGovernanceError("campaign_not_found");
  if (!["draft", "paused"].includes(campaign.status))
    throw new WhatsAppCampaignGovernanceError("campaign_not_activatable");
  if (campaign.trigger_type === "scheduled" &&
      (!campaign.scheduled_at || new Date(campaign.scheduled_at) <= new Date()))
    throw new WhatsAppCampaignGovernanceError("campaign_schedule_not_future");
  const { data: template, error: templateError } = await admin
    .from("wa_message_templates")
    .select("status")
    .eq("id", campaign.template_id)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (templateError || template?.status !== "approved")
    throw new WhatsAppCampaignGovernanceError("campaign_template_not_approved");
  const nextStatus = campaign.trigger_type === "scheduled" ? "scheduled" : "ready";
  const { error: updateError } = await admin
    .from("wa_campaigns")
    .update({ status: nextStatus, last_error: null, updated_at: new Date().toISOString() })
    .eq("id", input.campaignId)
    .eq("tenant_id", input.tenantId)
    .eq("status", campaign.status);
  if (updateError) throw new WhatsAppCampaignGovernanceError("campaign_activation_failed");
  return { campaignId: input.campaignId, status: nextStatus };
}

export async function findEventTriggeredWhatsAppCampaigns(
  admin: Db,
  input: { tenantId: string; propertyId: string; eventKey: string },
) {
  const { data, error } = await admin
    .from("wa_campaigns")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("trigger_type", "event")
    .eq("event_key", input.eventKey)
    .eq("status", "ready")
    .limit(50);
  if (error) throw new WhatsAppCampaignGovernanceError("event_campaign_lookup_failed");
  return (data ?? []).map((row: { id: string }) => row.id);
}

export async function evaluateWhatsAppCampaignAudience(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    campaignId: string;
    eventKey?: string | null;
    limit?: number;
  },
) {
  const { campaign } = await assertWhatsAppCampaignReady(
    admin,
    input.tenantId,
    input.propertyId,
    input.campaignId,
  );
  const filter = campaign.audience_filter ?? {};
  let query = admin
    .from("restaurant_guest_customers")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("status", "active")
    .not("whatsapp_user_id", "is", null)
    .or("first_property_id.eq." + input.propertyId + ",last_property_id.eq." + input.propertyId);
  if (filter.preferredLanguage === "en" || filter.preferredLanguage === "sw")
    query = query.eq("preferred_language", filter.preferredLanguage);
  if (typeof filter.lastSeenAfter === "string") query = query.gte("last_seen_at", filter.lastSeenAfter);
  if (typeof filter.lastSeenBefore === "string") query = query.lte("last_seen_at", filter.lastSeenBefore);
  const audienceLimit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
  const { data: guests, error, count } = await query
    .select("id", { count: "exact" })
    .limit(audienceLimit + 1);
  if (error) throw new WhatsAppCampaignGovernanceError("campaign_audience_query_failed");
  if ((typeof count === "number" && count > audienceLimit) || (guests ?? []).length > audienceLimit)
    throw new WhatsAppCampaignGovernanceError("campaign_audience_exceeds_single_execution_limit");

  let eligible = 0;
  let suppressed = 0;
  for (const guest of guests ?? []) {
    const result = await prepareWhatsAppCampaignRecipient(admin, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      campaignId: campaign.id,
      guestCustomerId: guest.id,
      eventKey: input.eventKey,
    });
    if (result.state === "eligible") eligible++;
    else suppressed++;
  }
  return { evaluated: (guests ?? []).length, eligible, suppressed };
}

export async function runWhatsAppCampaign(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    campaignId: string;
    eventKey?: string | null;
    limit?: number;
  },
) {
  const { campaign } = await assertWhatsAppCampaignReady(
    admin,
    input.tenantId,
    input.propertyId,
    input.campaignId,
  );
  if (campaign.trigger_type === "event" && campaign.status !== "ready")
    throw new WhatsAppCampaignGovernanceError("event_campaign_not_ready");
  if (campaign.trigger_type === "event" && !input.eventKey)
    throw new WhatsAppCampaignGovernanceError("campaign_event_key_required");
  const { error: startError } = await admin
    .from("wa_campaigns")
    .update({ status: "running", started_at: new Date().toISOString(), last_error: null })
    .eq("id", campaign.id)
    .eq("tenant_id", input.tenantId);
  if (startError) throw new WhatsAppCampaignGovernanceError("campaign_start_failed");

  try {
    const audience = await evaluateWhatsAppCampaignAudience(admin, input);
    const { data: recipients, error: recipientError } = await admin
      .from("wa_campaign_recipients")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .eq("campaign_id", campaign.id)
      .eq("state", "eligible")
      .limit(Math.min(Math.max(input.limit ?? 500, 1), 1000));
    if (recipientError) throw new WhatsAppCampaignGovernanceError("campaign_recipient_list_failed");
    let queued = 0;
    let suppressed = 0;
    for (const recipient of recipients ?? []) {
      const result = await queueWhatsAppCampaignRecipient(admin, {
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        campaignId: campaign.id,
        recipientId: recipient.id,
        eventKey: input.eventKey,
      });
      if (result.queued) queued++;
      else suppressed++;
    }
    const { error: completeError } = await admin
      .from("wa_campaigns")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", campaign.id)
      .eq("tenant_id", input.tenantId);
    if (completeError) throw new WhatsAppCampaignGovernanceError("campaign_completion_failed");
    return { ...audience, queued, suppressed, status: "completed" as const };
  } catch (error) {
    await admin
      .from("wa_campaigns")
      .update({ status: "paused", last_error: "campaign_execution_requires_review" })
      .eq("id", campaign.id)
      .eq("tenant_id", input.tenantId);
    throw error;
  }
}

/** Rechecks consent immediately before queuing a Meta-approved campaign template into the canonical WCE-02 outbox. */
export async function queueWhatsAppCampaignRecipient(
  admin: Db,
  input: {
    tenantId: string;
    propertyId: string;
    campaignId: string;
    recipientId: string;
    eventKey?: string | null;
  },
) {
  const { campaign, template } = await assertWhatsAppCampaignReady(
    admin,
    input.tenantId,
    input.propertyId,
    input.campaignId,
  );
  if (campaign.trigger_type === "event" && campaign.event_key !== input.eventKey)
    throw new WhatsAppCampaignGovernanceError("campaign_event_key_mismatch");
  const { data: recipient, error: recipientError } = await admin
    .from("wa_campaign_recipients")
    .select("id, guest_customer_id, state")
    .eq("id", input.recipientId)
    .eq("tenant_id", input.tenantId)
    .eq("campaign_id", campaign.id)
    .maybeSingle();
  if (recipientError || !recipient)
    throw new WhatsAppCampaignGovernanceError("campaign_recipient_not_found");
  if (recipient.state === "queued" || recipient.state === "sent")
    return { queued: true as const, duplicate: true as const };
  if (recipient.state !== "eligible")
    return { queued: false as const, reason: String(recipient.state) };

  const { data: guest, error: guestError } = await admin
    .from("restaurant_guest_customers")
    .select("id, whatsapp_user_id, status")
    .eq("id", recipient.guest_customer_id)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (guestError || !guest || !guest.whatsapp_user_id)
    throw new WhatsAppCampaignGovernanceError("campaign_guest_unavailable");
  if (guest.status === "blocked") {
    await admin.from("wa_campaign_recipients").update({
      state: "suppressed",
      suppression_reason: "guest_blocked",
    }).eq("id", recipient.id).eq("tenant_id", input.tenantId);
    return { queued: false as const, reason: "guest_blocked" };
  }
  if (
    template.category === "marketing" &&
    !(await hasWhatsAppGuestMarketingConsent(admin, input.tenantId, recipient.guest_customer_id))
  ) {
    await admin.from("wa_campaign_recipients").update({
      state: "suppressed",
      suppression_reason: "marketing_consent_revoked",
    }).eq("id", recipient.id).eq("tenant_id", input.tenantId);
    return { queued: false as const, reason: "marketing_consent_revoked" };
  }

  const { data: binding, error: bindingError } = await admin
    .from("wa_phone_number_bindings")
    .select("id, status")
    .eq("id", campaign.binding_id)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("location_id", campaign.location_id)
    .maybeSingle();
  if (bindingError || !binding || binding.status !== "active")
    throw new WhatsAppCampaignGovernanceError("campaign_binding_unavailable");

  const { data: existingConversation, error: conversationError } = await admin
    .from("wa_conversations")
    .select("id")
    .eq("binding_id", campaign.binding_id)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .eq("location_id", campaign.location_id)
    .eq("wa_user_id", guest.whatsapp_user_id)
    .in("status", ["open", "human_handoff"])
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (conversationError) throw new WhatsAppCampaignGovernanceError("campaign_conversation_lookup_failed");
  let conversationId = existingConversation?.id as string | undefined;
  if (!conversationId) {
    const { data: created, error: createError } = await admin
      .from("wa_conversations")
      .insert({
        tenant_id: input.tenantId,
        property_id: input.propertyId,
        location_id: campaign.location_id,
        binding_id: campaign.binding_id,
        wa_user_id: guest.whatsapp_user_id,
        guest_customer_id: recipient.guest_customer_id,
        status: "open",
        last_message_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (createError || !created) throw new WhatsAppCampaignGovernanceError("campaign_conversation_create_failed");
    conversationId = created.id;
  }

  const clientRequestId = "wa-campaign:" + campaign.id + ":" + recipient.guest_customer_id;
  const { data: existingMessage, error: existingMessageError } = await admin
    .from("wa_messages")
    .select("id, status")
    .eq("tenant_id", input.tenantId)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  if (existingMessageError)
    throw new WhatsAppCampaignGovernanceError("campaign_outbox_idempotency_lookup_failed");
  if (existingMessage) {
    const terminalFailure = existingMessage.status === "failed";
    const { error: recipientUpdateError } = await admin
      .from("wa_campaign_recipients")
      .update({
        state: terminalFailure ? "failed" : existingMessage.status === "sent" ? "sent" : "queued",
        message_id: existingMessage.id,
      })
      .eq("id", recipient.id)
      .eq("tenant_id", input.tenantId)
      .eq("state", "eligible");
    if (recipientUpdateError)
      throw new WhatsAppCampaignGovernanceError("campaign_recipient_queue_state_failed");
    if (terminalFailure) return { queued: false as const, reason: "existing_delivery_failed" };
    return { queued: true as const, duplicate: true as const, messageId: String(existingMessage.id) };
  }
  const metaRate = await resolveEffectiveMetaMessageRate(
    admin,
    campaign.market_code,
    template.category,
  );
  await accountWhatsAppCampaignMessageUsage(admin, input.tenantId, input.propertyId, 1);
  const { data: message, error: messageError } = await admin
    .from("wa_messages")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId,
      location_id: campaign.location_id,
      conversation_id: conversationId,
      provider_message_id: null,
      client_request_id: clientRequestId,
      direction: "outbound",
      message_type: "template",
      status: "queued",
      content: null,
      payload: {
        template: {
          name: template.template_name,
          language: template.language,
          components: campaign.message_components ?? [],
        },
        campaign_id: campaign.id,
        campaign_recipient_id: recipient.id,
        guest_customer_id: recipient.guest_customer_id,
        template_id: template.id,
        campaign_usage: {
          rate_id: metaRate.id,
          market_code: metaRate.marketCode,
          template_category: metaRate.category.toLowerCase(),
          unit_price: metaRate.unitPrice,
          currency: metaRate.currency,
        },
      },
      next_attempt_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  let messageId = message?.id as string | undefined;
  if (messageError?.code === "23505") {
    const { data: existingMessage, error: existingError } = await admin
      .from("wa_messages")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .eq("client_request_id", clientRequestId)
      .maybeSingle();
    if (existingError || !existingMessage)
      throw new WhatsAppCampaignGovernanceError("campaign_outbox_idempotency_lookup_failed");
    messageId = existingMessage.id;
  } else if (messageError || !messageId) {
    throw new WhatsAppCampaignGovernanceError("campaign_outbox_persistence_failed");
  }

  const { error: recipientUpdateError } = await admin
    .from("wa_campaign_recipients")
    .update({ state: "queued", message_id: messageId, suppression_reason: null })
    .eq("id", recipient.id)
    .eq("tenant_id", input.tenantId)
    .eq("state", "eligible");
  if (recipientUpdateError)
    throw new WhatsAppCampaignGovernanceError("campaign_recipient_queue_state_failed");
  return { queued: true as const, duplicate: Boolean(messageError?.code === "23505"), messageId };
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
