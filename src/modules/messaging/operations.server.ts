/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase query rows are validated at this server boundary. */
import {
  accessiblePropertyIds,
  assertCapability,
  assertTenantRead,
  getTenantScope,
} from "@/modules/restaurant/core/access.server";
import { assertCommercialAdmin } from "@/modules/commercial/access.server";
import { checkQuota } from "@/modules/commercial/quota.server";

type Db = any;

type TenantFilter = {
  tenantId: string;
  propertyId?: string;
  locationId?: string;
  from?: string;
  to?: string;
  limit?: number;
};

async function tenantQueryScope(
  sb: Db,
  userId: string,
  input: TenantFilter,
  capability = "guest.context.read",
) {
  const scope = await getTenantScope(sb, userId, input.tenantId);
  if (scope.platformAdmin || scope.grants.length === 0) {
    throw new Error("tenant_membership_required");
  }
  await assertTenantRead(
    sb,
    userId,
    input.tenantId,
    { propertyId: input.propertyId, locationId: input.locationId },
    scope,
  );
  await assertCapability(
    sb,
    userId,
    input.tenantId,
    capability as any,
    {
      propertyId: input.propertyId,
      locationId: input.locationId,
    },
    scope,
  );
  return {
    scope,
    propertyIds: input.propertyId ? [input.propertyId] : accessiblePropertyIds(scope),
  };
}

function applyPropertyScope(query: any, propertyIds: string[] | null, column = "property_id") {
  if (propertyIds === null) return query;
  if (propertyIds.length === 0) return query.in(column, ["00000000-0000-0000-0000-000000000000"]);
  return query.in(column, propertyIds);
}

function applyDateRange(query: any, input: TenantFilter, column = "created_at") {
  if (input.from) query = query.gte(column, input.from);
  if (input.to) query = query.lte(column, input.to);
  return query;
}

export async function listWhatsAppInbox(sb: Db, userId: string, input: TenantFilter) {
  const { propertyIds } = await tenantQueryScope(sb, userId, input);
  let query = sb
    .from("wa_conversations")
    .select(
      "id, tenant_id, property_id, location_id, guest_customer_id, wa_user_id, status, last_message_at, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("last_message_at", { ascending: false })
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 100));
  query = applyPropertyScope(query, propertyIds);
  if (input.locationId) query = query.eq("location_id", input.locationId);
  const { data: conversations, error } = await query;
  if (error) throw new Error("whatsapp_inbox_unavailable");

  const rows = conversations ?? [];
  const ids = rows.map((row: any) => row.id);
  const guestIds = [...new Set(rows.map((row: any) => row.guest_customer_id).filter(Boolean))];
  const [{ data: messages, error: messageError }, { data: guests, error: guestError }] =
    await Promise.all([
      ids.length
        ? sb
            .from("wa_messages")
            .select(
              "id, conversation_id, direction, message_type, status, content, created_at, sent_at, delivered_at, read_at, last_error",
            )
            .eq("tenant_id", input.tenantId)
            .in("conversation_id", ids)
            .order("created_at", { ascending: false })
            .limit(Math.min(ids.length * 3, 300))
        : Promise.resolve({ data: [], error: null }),
      guestIds.length
        ? sb
            .from("restaurant_guest_customers")
            .select("id, display_name, phone_e164, preferred_language, status")
            .eq("tenant_id", input.tenantId)
            .in("id", guestIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
  if (messageError || guestError) throw new Error("whatsapp_inbox_context_unavailable");

  const latestMessage = new Map<string, any>();
  for (const message of messages ?? []) {
    if (!latestMessage.has(message.conversation_id))
      latestMessage.set(message.conversation_id, message);
  }
  const guestMap = new Map((guests ?? []).map((guest: any) => [guest.id, guest]));
  return rows.map((conversation: any) => ({
    ...conversation,
    guest: guestMap.get(conversation.guest_customer_id) ?? null,
    latestMessage: latestMessage.get(conversation.id) ?? null,
  }));
}

export async function getWhatsAppConversation(
  sb: Db,
  userId: string,
  input: TenantFilter & { conversationId: string },
) {
  await tenantQueryScope(sb, userId, input);
  const { data: conversation, error } = await sb
    .from("wa_conversations")
    .select(
      "id, tenant_id, property_id, location_id, guest_customer_id, wa_user_id, status, last_message_at, created_at",
    )
    .eq("id", input.conversationId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (error || !conversation) throw new Error("whatsapp_conversation_not_found");
  await tenantQueryScope(sb, userId, {
    ...input,
    propertyId: conversation.property_id,
    locationId: conversation.location_id,
  });
  const [{ data: messages, error: messageError }, { data: guest, error: guestError }] =
    await Promise.all([
      sb
        .from("wa_messages")
        .select(
          "id, direction, message_type, status, content, payload, created_at, sent_at, delivered_at, read_at, last_error",
        )
        .eq("tenant_id", input.tenantId)
        .eq("property_id", conversation.property_id)
        .eq("location_id", conversation.location_id)
        .eq("conversation_id", conversation.id)
        .order("created_at", { ascending: true })
        .limit(200),
      conversation.guest_customer_id
        ? sb
            .from("restaurant_guest_customers")
            .select("id, display_name, phone_e164, preferred_language, status")
            .eq("tenant_id", input.tenantId)
            .eq("id", conversation.guest_customer_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
  if (messageError || guestError) throw new Error("whatsapp_conversation_history_unavailable");
  return { conversation, guest, messages: messages ?? [] };
}

export async function listWhatsAppGuestCRM(sb: Db, userId: string, input: TenantFilter) {
  const { propertyIds } = await tenantQueryScope(sb, userId, input);
  let query = sb
    .from("restaurant_guest_customers")
    .select(
      "id, tenant_id, first_property_id, last_property_id, phone_e164, whatsapp_user_id, display_name, preferred_language, status, first_seen_at, last_seen_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("last_seen_at", { ascending: false })
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 250));
  if (input.propertyId) {
    query = query.or(
      "first_property_id.eq." + input.propertyId + ",last_property_id.eq." + input.propertyId,
    );
  } else if (propertyIds !== null) {
    if (propertyIds.length === 0) return [];
    query = query.or(
      "first_property_id.in.(" +
        propertyIds.join(",") +
        "),last_property_id.in.(" +
        propertyIds.join(",") +
        ")",
    );
  }
  const { data: guests, error } = await query;
  if (error) throw new Error("whatsapp_guest_crm_unavailable");
  const ids = (guests ?? []).map((guest: any) => guest.id);
  const { data: consents, error: consentError } = ids.length
    ? await sb
        .from("restaurant_guest_customer_consents")
        .select(
          "id, guest_customer_id, property_id, channel, purpose, state, evidence_source, recorded_at",
        )
        .eq("tenant_id", input.tenantId)
        .in("guest_customer_id", ids)
        .order("recorded_at", { ascending: false })
    : { data: [], error: null };
  if (consentError) throw new Error("whatsapp_guest_consent_unavailable");
  const latest = new Map<string, any>();
  for (const consent of consents ?? []) {
    const key = consent.guest_customer_id + ":" + consent.purpose;
    if (!latest.has(key)) latest.set(key, consent);
  }
  return (guests ?? []).map((guest: any) => ({
    ...guest,
    marketingConsent: latest.get(guest.id + ":marketing") ?? null,
    serviceUpdatesConsent: latest.get(guest.id + ":service_updates") ?? null,
  }));
}

export async function getWhatsAppCampaignWorkspace(sb: Db, userId: string, input: TenantFilter) {
  const { propertyIds } = await tenantQueryScope(sb, userId, input);
  let templatesQuery = sb
    .from("wa_message_templates")
    .select(
      "id, tenant_id, property_id, template_name, language, category, status, meta_template_id, rejection_reason, submitted_at, reviewed_at, synced_at, created_at, updated_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("updated_at", { ascending: false })
    .limit(100);
  let campaignsQuery = sb
    .from("wa_campaigns")
    .select(
      "id, tenant_id, property_id, location_id, name, market_code, template_id, trigger_type, event_key, audience_filter, status, scheduled_at, started_at, completed_at, daily_cap, total_cap, last_error, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (input.propertyId) {
    templatesQuery = templatesQuery.or("property_id.is.null,property_id.eq." + input.propertyId);
    campaignsQuery = campaignsQuery.eq("property_id", input.propertyId);
  } else if (propertyIds !== null) {
    if (propertyIds.length === 0) return { templates: [], campaigns: [] };
    templatesQuery = templatesQuery.or(
      "property_id.is.null,property_id.in.(" + propertyIds.join(",") + ")",
    );
    campaignsQuery = campaignsQuery.in("property_id", propertyIds);
  }
  if (input.locationId) campaignsQuery = campaignsQuery.eq("location_id", input.locationId);
  let bindingsQuery = sb
    .from("wa_phone_number_bindings")
    .select(
      "id, tenant_id, property_id, location_id, display_phone_number, waba_id, phone_number_id, status, quality_rating",
    )
    .eq("tenant_id", input.tenantId)
    .eq("status", "active");
  bindingsQuery = applyPropertyScope(bindingsQuery, propertyIds);
  const [
    { data: templates, error: templateError },
    { data: campaigns, error: campaignError },
    { data: bindings, error: bindingError },
  ] = await Promise.all([templatesQuery, campaignsQuery, bindingsQuery]);
  if (templateError || campaignError || bindingError) {
    throw new Error("whatsapp_campaign_workspace_unavailable");
  }
  return { templates: templates ?? [], campaigns: campaigns ?? [], bindings: bindings ?? [] };
}

export async function getWhatsAppUsageReport(sb: Db, userId: string, input: TenantFilter) {
  const { propertyIds } = await tenantQueryScope(sb, userId, input, "profitability.manage");
  let campaignQuery = sb
    .from("wa_campaign_usage_ledger")
    .select(
      "id, tenant_id, property_id, location_id, campaign_id, usage_component, usage_event, quantity, unit_price, amount, currency, market_code, template_category, rate_snapshot, recorded_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("recorded_at", { ascending: false })
    .limit(2000);
  let aiQuery = sb
    .from("commercial_ai_usage_log")
    .select(
      "id, tenant_id, property_id, location_id, workload_type, request_count, estimated_cost, estimated_cost_known, currency, occurred_at",
    )
    .eq("tenant_id", input.tenantId)
    .eq("source_channel", "whatsapp")
    .eq("workload_type", "ai_concierge.reply")
    .order("occurred_at", { ascending: false })
    .limit(2000);
  campaignQuery = applyPropertyScope(campaignQuery, propertyIds);
  aiQuery = applyPropertyScope(aiQuery, propertyIds);
  campaignQuery = applyDateRange(campaignQuery, input, "recorded_at");
  aiQuery = applyDateRange(aiQuery, input, "occurred_at");
  if (input.locationId) {
    campaignQuery = campaignQuery.eq("location_id", input.locationId);
    aiQuery = aiQuery.eq("location_id", input.locationId);
  }
  const [{ data: campaignRows, error: campaignError }, { data: aiRows, error: aiError }] =
    await Promise.all([campaignQuery, aiQuery]);
  if (campaignError || aiError) throw new Error("whatsapp_usage_report_unavailable");
  const entries = [
    ...(campaignRows ?? []).map((row: any) => ({
      ...row,
      costKnown: true,
      source: "wa_campaign_usage_ledger",
    })),
    ...(aiRows ?? []).map((row: any) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      property_id: row.property_id,
      location_id: row.location_id,
      usage_component: "ai",
      usage_event: row.workload_type,
      quantity: row.request_count,
      unit_price: null,
      amount: row.estimated_cost_known === true ? row.estimated_cost : null,
      costKnown: row.estimated_cost_known === true,
      currency: row.currency,
      recorded_at: row.occurred_at,
      source: "commercial_ai_usage_log",
    })),
  ];
  const totals = new Map<
    string,
    {
      component: string;
      currency: string;
      amount: number;
      quantity: number;
      entries: number;
      unpricedEntries: number;
      costComplete: boolean;
    }
  >();
  for (const row of entries) {
    const key = row.usage_component + ":" + row.currency;
    const current = totals.get(key) ?? {
      component: row.usage_component,
      currency: row.currency,
      amount: 0,
      quantity: 0,
      entries: 0,
      unpricedEntries: 0,
      costComplete: true,
    };
    if (row.costKnown === false) {
      current.unpricedEntries++;
      current.costComplete = false;
    } else {
      current.amount += Number(row.amount ?? 0);
    }
    current.quantity += Number(row.quantity ?? 0);
    current.entries++;
    totals.set(key, current);
  }
  const lexibiteQuota = await checkQuota(
    sb,
    input.tenantId,
    "whatsapp_campaign_messages",
    input.propertyId,
  );
  return { entries, totals: [...totals.values()], lexibiteQuota };
}

export async function getWhatsAppConversionReport(sb: Db, userId: string, input: TenantFilter) {
  const { propertyIds } = await tenantQueryScope(sb, userId, input);
  // Guest Portal sessions are service-role-only in WCE-02. Authorize the
  // tenant/property scope first, then perform an explicitly filtered aggregate
  // read through the server admin client; raw session rows never leave here.
  const analyticsDb = await serviceAdmin();
  let sessionsQuery = analyticsDb
    .from("wa_guest_portal_sessions")
    .select(
      "id, tenant_id, property_id, location_id, conversation_id, acquisition_channel, open_count, opened_at, created_at, expires_at, revoked_at",
    )
    .eq("tenant_id", input.tenantId)
    .eq("acquisition_channel", "whatsapp")
    .order("created_at", { ascending: false })
    .limit(2000);
  let ordersQuery = analyticsDb
    .from("restaurant_orders")
    .select(
      "id, tenant_id, property_id, location_id, guest_portal_session_id, status, payment_state, total, currency, opened_at, closed_at",
    )
    .eq("tenant_id", input.tenantId)
    .not("guest_portal_session_id", "is", null)
    .order("opened_at", { ascending: false })
    .limit(2000);
  sessionsQuery = applyPropertyScope(sessionsQuery, propertyIds);
  ordersQuery = applyPropertyScope(ordersQuery, propertyIds);
  sessionsQuery = applyDateRange(sessionsQuery, input);
  ordersQuery = applyDateRange(ordersQuery, input, "opened_at");
  if (input.locationId) {
    sessionsQuery = sessionsQuery.eq("location_id", input.locationId);
    ordersQuery = ordersQuery.eq("location_id", input.locationId);
  }
  const [{ data: sessions, error: sessionError }, { data: orders, error: orderError }] =
    await Promise.all([sessionsQuery, ordersQuery]);
  if (sessionError || orderError) throw new Error("whatsapp_conversion_report_unavailable");
  const openedSessions = (sessions ?? []).filter((session: any) => Boolean(session.opened_at));
  const sessionIds = new Set(openedSessions.map((session: any) => session.id));
  const linkedOrders = (orders ?? []).filter((order: any) =>
    sessionIds.has(order.guest_portal_session_id),
  );
  const paidOrders = linkedOrders.filter((order: any) => order.payment_state === "paid");
  const convertedSessionIds = new Set(
    linkedOrders.map((order: any) => order.guest_portal_session_id),
  );
  const revenue = new Map<string, number>();
  for (const order of paidOrders) {
    revenue.set(order.currency, (revenue.get(order.currency) ?? 0) + Number(order.total ?? 0));
  }
  return {
    sessionsCreated: (sessions ?? []).length,
    sessionsOpened: openedSessions.length,
    ordersPlaced: linkedOrders.length,
    ordersPaid: paidOrders.length,
    sessionsWithOrders: convertedSessionIds.size,
    sessionToOrderRate: openedSessions.length
      ? convertedSessionIds.size / openedSessions.length
      : 0,
    orderToPaidRate: linkedOrders.length ? paidOrders.length / linkedOrders.length : 0,
    paidRevenueByCurrency: [...revenue.entries()].map(([currency, amount]) => ({
      currency,
      amount,
    })),
  };
}

export async function getFounderWhatsAppOverview(sb: Db, userId: string) {
  await assertCommercialAdmin(sb, userId);
  const admin = (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const [
    { data: bindings, error: bindingError },
    { data: integrations, error: integrationError },
    { data: webhookEvents, error: webhookError },
    { data: messages, error: messageError },
    { data: usage, error: usageError },
    { data: aiUsage, error: aiUsageError },
  ] = await Promise.all([
    admin
      .from("wa_phone_number_bindings")
      .select(
        "id, tenant_id, property_id, location_id, integration_id, waba_id, phone_number_id, display_phone_number, verified_name, quality_rating, status, updated_at",
      )
      .order("updated_at", { ascending: false })
      .limit(500),
    admin
      .from("api_integrations")
      .select(
        "id, tenant_id, property_id, provider, channel_key, integration_type, status, updated_at",
      )
      .eq("provider", "meta-whatsapp")
      .order("updated_at", { ascending: false })
      .limit(500),
    admin
      .from("wa_webhook_events")
      .select(
        "id, tenant_id, property_id, status, received_at, processed_at, attempt_count, last_error",
      )
      .order("received_at", { ascending: false })
      .limit(1000),
    admin
      .from("wa_messages")
      .select("id, tenant_id, property_id, status, created_at, sent_at, delivered_at, last_error")
      .order("created_at", { ascending: false })
      .limit(1000),
    admin
      .from("wa_campaign_usage_ledger")
      .select("tenant_id, property_id, location_id, usage_component, amount, currency, recorded_at")
      .order("recorded_at", { ascending: false })
      .limit(2000),
    admin
      .from("commercial_ai_usage_log")
      .select(
        "tenant_id, property_id, source_channel, workload_type, request_count, estimated_cost, estimated_cost_known, currency, occurred_at",
      )
      .eq("source_channel", "whatsapp")
      .eq("workload_type", "ai_concierge.reply")
      .order("occurred_at", { ascending: false })
      .limit(2000),
  ]);
  if (
    bindingError ||
    integrationError ||
    webhookError ||
    messageError ||
    usageError ||
    aiUsageError
  ) {
    throw new Error("founder_whatsapp_overview_unavailable");
  }
  const { data: quotaDefinitions, error: quotaDefinitionError } = await admin
    .from("commercial_quota_definitions")
    .select("id, code, unit, period, scope")
    .eq("code", "whatsapp_campaign_messages")
    .limit(50);
  if (quotaDefinitionError) throw new Error("founder_whatsapp_quota_definitions_unavailable");
  const quotaDefinitionIds = (quotaDefinitions ?? []).map((row: any) => row.id);
  const { data: quotaCounters, error: quotaCounterError } = quotaDefinitionIds.length
    ? await admin
        .from("commercial_usage_counters")
        .select("tenant_id, property_id, quota_definition_id, period_start, period_end, used_value, state")
        .in("quota_definition_id", quotaDefinitionIds)
        .gt("period_end", new Date().toISOString())
        .order("period_start", { ascending: false })
        .limit(1000)
    : { data: [], error: null };
  if (quotaCounterError) throw new Error("founder_whatsapp_quota_usage_unavailable");
  const quotaDefinitionMap = new Map((quotaDefinitions ?? []).map((row: any) => [row.id, row]));
  const tenantIds = [
    ...new Set([
      ...(bindings ?? []).map((row: any) => row.tenant_id),
      ...(integrations ?? []).map((row: any) => row.tenant_id),
      ...(aiUsage ?? []).map((row: any) => row.tenant_id),
      ...(quotaCounters ?? []).map((row: any) => row.tenant_id),
    ]),
  ];
  const { data: tenants, error: tenantError } = tenantIds.length
    ? await admin.from("restaurant_tenants").select("id, name, slug").in("id", tenantIds)
    : { data: [], error: null };
  if (tenantError) throw new Error("founder_whatsapp_tenants_unavailable");
  const tenantMap = new Map((tenants ?? []).map((row: any) => [row.id, row]));
  const countBy = (rows: any[], key: string) =>
    rows.reduce((counts: Record<string, number>, row: any) => {
      const value = String(row[key] ?? "unknown");
      counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    }, {});
  const invoices = await (
    await import("@/modules/commercial/billing.server")
  ).listInvoices(admin, {});
  const invoiceTotals = new Map<
    string,
    { currency: string; issuedAmount: number; outstandingBalance: number; count: number }
  >();
  for (const invoice of invoices) {
    const currency = String(invoice.currency ?? "UNKNOWN");
    const current = invoiceTotals.get(currency) ?? {
      currency,
      issuedAmount: 0,
      outstandingBalance: 0,
      count: 0,
    };
    if (["issued", "paid", "partially_paid"].includes(invoice.status)) {
      current.issuedAmount += Number(invoice.total ?? 0);
    }
    current.outstandingBalance += Number(invoice.balance ?? 0);
    current.count++;
    invoiceTotals.set(currency, current);
  }
  const invoiceSummary = {
    count: invoices.length,
    byCurrency: [...invoiceTotals.values()],
  };
  const usageRows = [
    ...(usage ?? []).map((row: any) => ({
      component: row.usage_component,
      currency: row.currency,
      amount: row.amount,
      costKnown: true,
    })),
    ...(aiUsage ?? []).map((row: any) => ({
      component: "ai",
      currency: row.currency,
      amount: row.estimated_cost,
      costKnown: row.estimated_cost_known === true,
    })),
  ];
  const usageSummary: Record<string, number> = {};
  const usageUnpriced: Record<string, number> = {};
  for (const row of usageRows) {
    const key = row.component + ":" + row.currency;
    if (row.costKnown === false) {
      usageUnpriced[key] = (usageUnpriced[key] ?? 0) + 1;
    } else {
      usageSummary[key] = (usageSummary[key] ?? 0) + Number(row.amount ?? 0);
    }
  }
  return {
    bindings: (bindings ?? []).map((row: any) => ({
      ...row,
      tenant: tenantMap.get(row.tenant_id) ?? null,
      integration: (integrations ?? []).find((item: any) => item.id === row.integration_id) ?? null,
    })),
    integrationCount: (integrations ?? []).length,
    webhookHealth: {
      total: (webhookEvents ?? []).length,
      byStatus: countBy(webhookEvents ?? [], "status"),
      deadLetters: (webhookEvents ?? []).filter((row: any) => row.status === "dead_letter").length,
      rejected: (webhookEvents ?? []).filter((row: any) => row.status === "rejected").length,
    },
    messageHealth: {
      total: (messages ?? []).length,
      byStatus: countBy(messages ?? [], "status"),
      failed: (messages ?? []).filter((row: any) => row.status === "failed").length,
    },
    usage: usageSummary,
    usageUnpriced,
    lexibiteQuotaUsage: (quotaCounters ?? []).map((row: any) => ({
      ...row,
      quota: quotaDefinitionMap.get(row.quota_definition_id) ?? null,
      tenant: tenantMap.get(row.tenant_id) ?? null,
    })),
    invoiceSummary,
  };
}

async function serviceAdmin() {
  return (await import("@/integrations/supabase/client.server")).supabaseAdmin;
}

export async function createWhatsAppTemplateDraft(
  sb: Db,
  userId: string,
  input: TenantFilter & {
    templateName: string;
    language: string;
    category: "marketing" | "utility" | "authentication";
    components?: Array<Record<string, unknown>>;
  },
) {
  await tenantQueryScope(sb, userId, input, "guest.context.manage");
  const admin = await serviceAdmin();
  const { data, error } = await admin
    .from("wa_message_templates")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      template_name: input.templateName.trim(),
      language: input.language,
      category: input.category,
      components: input.components ?? [],
      status: "draft",
      created_by: userId,
    })
    .select("id, template_name, language, category, status")
    .single();
  if (error || !data) throw new Error("whatsapp_template_draft_create_failed");
  return data;
}

export async function createWhatsAppCampaignDraft(
  sb: Db,
  userId: string,
  input: TenantFilter & {
    propertyId: string;
    locationId: string;
    bindingId: string;
    marketCode: string;
    templateId: string;
    name: string;
    triggerType: "scheduled" | "event";
    eventKey?: string | null;
    scheduledAt?: string | null;
    dailyCap?: number | null;
    totalCap?: number | null;
    preferredLanguage?: "en" | "sw";
  },
) {
  await tenantQueryScope(sb, userId, input, "guest.context.manage");
  const admin = await serviceAdmin();
  const mod = await import("./campaign-governance.server");
  return mod.createWhatsAppCampaign(admin, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    bindingId: input.bindingId,
    marketCode: input.marketCode,
    templateId: input.templateId,
    name: input.name,
    triggerType: input.triggerType,
    eventKey: input.eventKey,
    scheduledAt: input.scheduledAt,
    dailyCap: input.dailyCap,
    totalCap: input.totalCap,
    audienceFilter: input.preferredLanguage ? { preferredLanguage: input.preferredLanguage } : {},
    createdBy: userId,
  });
}

export async function activateWhatsAppCampaignForTenant(
  sb: Db,
  userId: string,
  input: TenantFilter & { propertyId: string; campaignId: string },
) {
  await tenantQueryScope(sb, userId, input, "guest.context.manage");
  const admin = await serviceAdmin();
  return (await import("./campaign-governance.server")).activateWhatsAppCampaign(admin, input);
}

export async function pauseWhatsAppCampaignForTenant(
  sb: Db,
  userId: string,
  input: TenantFilter & { propertyId: string; campaignId: string },
) {
  await tenantQueryScope(sb, userId, input, "guest.context.manage");
  const admin = await serviceAdmin();
  const { data, error } = await admin
    .from("wa_campaigns")
    .update({ status: "paused", updated_at: new Date().toISOString() })
    .eq("id", input.campaignId)
    .eq("tenant_id", input.tenantId)
    .eq("property_id", input.propertyId)
    .in("status", ["ready", "scheduled", "running"])
    .select("id, status")
    .maybeSingle();
  if (error || !data) throw new Error("whatsapp_campaign_pause_failed");
  return data;
}
