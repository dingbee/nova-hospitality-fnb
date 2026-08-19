/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Commercial configuration services: currencies, exchange rates, versioned
 * prices, taxes, service charges, discounts and promotions.
 *
 * Two invariants govern this file:
 *  1. Prices are never overwritten — a change supersedes the previous version.
 *  2. Every change is audited and emitted as a fact; no reasoning happens here.
 */
import type { z } from "zod";
import {
  assertCapability,
  assertTenantRead,
  isPlatformAdmin,
  rolesInTenant,
} from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { evaluateDiscount } from "./engine";
import type {
  applyDiscountSchema,
  decidePriceSchema,
  listCommercialRulesSchema,
  listCurrenciesSchema,
  listExchangeRatesSchema,
  listPricesSchema,
  listPriceListsSchema,
  listRoundingRulesSchema,
  pricingAuditSchema,
  setPromotionStatusSchema,
  upsertCurrencySchema,
  upsertDiscountRuleSchema,
  upsertExchangeRateSchema,
  upsertPriceSchema,
  upsertPriceListSchema,
  upsertPromotionSchema,
  upsertRoundingRuleSchema,
  upsertServiceChargeSchema,
  upsertTaxRuleSchema,
} from "./contracts";

type Sb = any;

async function audit(
  sb: Sb,
  userId: string,
  entry: {
    tenantId: string;
    entityType: string;
    entityId?: string | null;
    action: string;
    previousValue?: unknown;
    newValue?: unknown;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const { error } = await sb.from("restaurant_pricing_audit").insert({
    tenant_id: entry.tenantId,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    action: entry.action,
    previous_value: entry.previousValue ?? null,
    new_value: entry.newValue ?? null,
    reason: entry.reason ?? null,
    actor_id: userId,
    metadata: entry.metadata ?? {},
  });
  if (error) console.warn("[pricing] audit not recorded", entry.action, error.message);
}

/* ---------------- Currencies ---------------- */

export async function listCurrencies(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listCurrenciesSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_currencies")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("code");
  if (input.activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertCurrency(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertCurrencySchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "pricing.manage");
  const row = {
    tenant_id: input.tenantId,
    code: input.code,
    symbol: input.symbol,
    name: input.name,
    decimals: input.decimals,
    rounding: input.rounding,
    is_base: input.isBase,
    active: input.active,
    created_by: userId,
  };
  const { data, error } = await sb
    .from("restaurant_currencies")
    .upsert(row, { onConflict: "tenant_id,code" })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  // Exactly one base currency per tenant keeps conversion unambiguous.
  if (input.isBase) {
    await sb
      .from("restaurant_currencies")
      .update({ is_base: false })
      .eq("tenant_id", input.tenantId)
      .neq("id", data.id);
  }
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "currency",
    entityId: data.id,
    action: "upsert",
    newValue: row,
  });
  return data;
}

/* ---------------- Exchange rates ---------------- */

export async function listExchangeRates(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listExchangeRatesSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_exchange_rates")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("effective_from", { ascending: false })
    .limit(input.limit);
  if (input.baseCurrency) q = q.eq("base_currency", input.baseCurrency);
  if (input.targetCurrency) q = q.eq("target_currency", input.targetCurrency);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertExchangeRate(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertExchangeRateSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "pricing.manage");
  const row = {
    tenant_id: input.tenantId,
    base_currency: input.baseCurrency.toUpperCase(),
    target_currency: input.targetCurrency.toUpperCase(),
    rate: input.rate,
    source: input.source,
    manual_override: input.manualOverride,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_to: input.effectiveTo ?? null,
    note: input.note ?? null,
    created_by: userId,
  };
  const q = input.id
    ? sb
        .from("restaurant_exchange_rates")
        .update(row)
        .eq("id", input.id)
        .eq("tenant_id", input.tenantId)
    : sb.from("restaurant_exchange_rates").insert(row);
  const { data, error } = await q.select("*").single();
  if (error) throw new Error(error.message);
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "exchange_rate",
    entityId: data.id,
    action: "upsert",
    newValue: row,
  });
  return data;
}

/* ---------------- Prices ---------------- */

export async function listPrices(sb: Sb, userId: string, input: z.infer<typeof listPricesSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_prices")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("effective_from", { ascending: false })
    .limit(input.limit);
  if (input.productId) q = q.eq("product_id", input.productId);
  if (input.menuItemId) q = q.eq("menu_item_id", input.menuItemId);
  if (input.status) q = q.eq("status", input.status);
  else if (!input.includeHistory) q = q.eq("status", "active");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Creates the next version of a price. The previous active price on the same
 * target and scope is superseded and closed off — never rewritten — so orders
 * already priced against it stay reproducible.
 */
export async function upsertPrice(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertPriceSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "pricing.manage");
  if (!input.productId && !input.menuItemId)
    throw new Error("A price needs a product or a menu item.");

  let q = sb
    .from("restaurant_prices")
    .select("id, version, amount, currency, status")
    .eq("tenant_id", input.tenantId)
    .eq("scope", input.scope)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1);
  q = input.productId
    ? q.eq("product_id", input.productId)
    : q.eq("menu_item_id", input.menuItemId);
  q = input.propertyId ? q.eq("property_id", input.propertyId) : q.is("property_id", null);
  q = input.locationId ? q.eq("location_id", input.locationId) : q.is("location_id", null);
  q = input.priceListId ? q.eq("price_list_id", input.priceListId) : q.is("price_list_id", null);
  q = input.channel ? q.eq("channel", input.channel) : q.is("channel", null);
  const { data: currentRows } = await q;
  const current = ((currentRows ?? []) as any[])[0] ?? null;

  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();
  const status = input.requiresApproval ? "pending_approval" : input.activate ? "active" : "draft";

  const { data, error } = await sb
    .from("restaurant_prices")
    .insert({
      tenant_id: input.tenantId,
      product_id: input.productId ?? null,
      variant_id: input.variantId ?? null,
      menu_item_id: input.menuItemId ?? null,
      scope: input.scope,
      property_id: input.propertyId ?? null,
      location_id: input.locationId ?? null,
      price_list_id: input.priceListId ?? null,
      channel: input.channel ?? null,
      currency: input.currency.toUpperCase(),
      amount: input.amount,
      tax_inclusive: input.taxInclusive,
      version: (current?.version ?? 0) + 1,
      status,
      effective_from: effectiveFrom,
      effective_to: input.effectiveTo ?? null,
      reason: input.reason ?? null,
      supersedes_id: current?.id ?? null,
      requires_approval: input.requiresApproval,
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  if (current && status === "active") {
    await sb
      .from("restaurant_prices")
      .update({ status: "superseded", effective_to: effectiveFrom })
      .eq("id", current.id)
      .eq("tenant_id", input.tenantId);
  }

  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "price",
    entityId: data.id,
    action: current ? "price.updated" : "price.created",
    previousValue: current ? { amount: current.amount, currency: current.currency } : null,
    newValue: { amount: data.amount, currency: data.currency, scope: data.scope, status },
    reason: input.reason ?? null,
  });
  await emitRestaurantEvent(sb, userId, {
    type: current ? "restaurant.price.updated" : "restaurant.price.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "price",
    entityId: data.id,
    payload: {
      scope: data.scope,
      currency: data.currency,
      previous_amount: current ? Number(current.amount) : null,
      amount: Number(data.amount),
      change_percent:
        current && Number(current.amount) > 0
          ? Number(
              (
                ((Number(data.amount) - Number(current.amount)) / Number(current.amount)) *
                100
              ).toFixed(2),
            )
          : null,
      status,
    },
    source: "restaurant-pricing",
  });
  return data;
}

export async function decidePrice(
  sb: Sb,
  userId: string,
  input: z.infer<typeof decidePriceSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "pricing.approve");
  const { data: existing } = await sb
    .from("restaurant_prices")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.priceId)
    .single();
  if (!existing) throw new Error("Price not found.");
  if (existing.status !== "pending_approval")
    throw new Error("Only a pending price can be decided.");

  const approve = input.decision === "approve";
  const { data, error } = await sb
    .from("restaurant_prices")
    .update({
      status: approve ? "active" : "rejected",
      approved_by: approve ? userId : null,
      approved_at: approve ? new Date().toISOString() : null,
      rejected_reason: approve ? null : (input.reason ?? "Rejected"),
    })
    .eq("id", input.priceId)
    .eq("tenant_id", input.tenantId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  if (approve && existing.supersedes_id) {
    await sb
      .from("restaurant_prices")
      .update({ status: "superseded", effective_to: new Date().toISOString() })
      .eq("id", existing.supersedes_id)
      .eq("tenant_id", input.tenantId);
  }
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "price",
    entityId: input.priceId,
    action: approve ? "price.approved" : "price.rejected",
    newValue: { status: data.status },
    reason: input.reason ?? null,
  });
  if (approve) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.price.approved",
      tenantId: input.tenantId,
      entityType: "price",
      entityId: input.priceId,
      payload: { amount: Number(data.amount), currency: data.currency, scope: data.scope },
      source: "restaurant-pricing",
    });
  }
  return data;
}

/* ---------------- Taxes & service charges ---------------- */

export async function listTaxRules(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listCommercialRulesSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_tax_rules")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("priority");
  if (input.activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertTaxRule(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertTaxRuleSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "tax.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    code: input.code,
    name: input.name,
    basis: input.basis,
    rate: input.rate,
    fixed_amount: input.fixedAmount,
    inclusive: input.inclusive,
    applies_to_categories: input.appliesToCategories,
    applies_to_products: input.appliesToProducts,
    priority: input.priority,
    compound: input.compound,
    applies_to_channels: input.appliesToChannels,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_to: input.effectiveTo ?? null,
    active: input.active,
    created_by: userId,
  };
  const q = input.id
    ? sb.from("restaurant_tax_rules").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_tax_rules").insert(row);
  const { data, error } = await q.select("*").single();
  if (error) throw new Error(error.message);
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "tax_rule",
    entityId: data.id,
    action: "upsert",
    newValue: row,
  });
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.tax.rule.created",
    tenantId: input.tenantId,
    entityType: "tax_rule",
    entityId: data.id,
    payload: {
      code: data.code,
      rate: Number(data.rate),
      inclusive: data.inclusive,
      basis: data.basis,
    },
    source: "restaurant-pricing",
  });
  return data;
}

export async function listServiceCharges(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listCommercialRulesSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_service_charges")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("code");
  if (input.activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertServiceCharge(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertServiceChargeSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "tax.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    code: input.code,
    name: input.name,
    basis: input.basis,
    rate: input.rate,
    fixed_amount: input.fixedAmount,
    applies_to_categories: input.appliesToCategories,
    applies_to_products: input.appliesToProducts,
    applies_to_order_types: input.appliesToOrderTypes,
    applies_to_channels: input.appliesToChannels,
    taxable: input.taxable,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_to: input.effectiveTo ?? null,
    active: input.active,
    created_by: userId,
  };
  const q = input.id
    ? sb
        .from("restaurant_service_charges")
        .update(row)
        .eq("id", input.id)
        .eq("tenant_id", input.tenantId)
    : sb.from("restaurant_service_charges").insert(row);
  const { data, error } = await q.select("*").single();
  if (error) throw new Error(error.message);
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "service_charge",
    entityId: data.id,
    action: "upsert",
    newValue: row,
  });
  return data;
}

/* ---------------- Discounts ---------------- */

export async function listDiscountRules(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listCommercialRulesSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_discount_rules")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("code");
  if (input.activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertDiscountRule(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertDiscountRuleSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "discount.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    code: input.code,
    name: input.name,
    scope: input.scope,
    basis: input.basis,
    value: input.value,
    max_percent: input.maxPercent,
    applies_to_categories: input.appliesToCategories,
    applies_to_products: input.appliesToProducts,
    requires_reason: input.requiresReason,
    approval_threshold_percent: input.approvalThresholdPercent ?? null,
    role_limits: input.roleLimits,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_to: input.effectiveTo ?? null,
    active: input.active,
    created_by: userId,
  };
  const q = input.id
    ? sb
        .from("restaurant_discount_rules")
        .update(row)
        .eq("id", input.id)
        .eq("tenant_id", input.tenantId)
    : sb.from("restaurant_discount_rules").insert(row);
  const { data, error } = await q.select("*").single();
  if (error) throw new Error(error.message);
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "discount_rule",
    entityId: data.id,
    action: "upsert",
    newValue: row,
  });
  return data;
}

/**
 * Applies a governed discount to an order or a single line. Authority comes
 * from the caller's restaurant roles — no separate permission system.
 */
export async function applyDiscount(
  sb: Sb,
  userId: string,
  input: z.infer<typeof applyDiscountSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");
  const admin = await isPlatformAdmin(sb, userId);
  const roles = await rolesInTenant(sb, userId, input.tenantId);

  const { data: rule } = input.discountRuleId
    ? await sb
        .from("restaurant_discount_rules")
        .select("*")
        .eq("tenant_id", input.tenantId)
        .eq("id", input.discountRuleId)
        .single()
    : { data: null };

  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, currency, subtotal, discount_total, location_id, property_id, status")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .single();
  if (!order) throw new Error("Order not found.");
  if (order.status === "closed" || order.status === "voided") {
    throw new Error("A settled order can no longer be discounted — its pricing is final.");
  }

  let base = Number(order.subtotal ?? 0);
  let item: any = null;
  if (input.orderItemId) {
    const { data } = await sb
      .from("restaurant_order_items")
      .select("id, quantity, unit_price, discount, line_total")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.orderItemId)
      .single();
    if (!data) throw new Error("Order line not found.");
    item = data;
    base = Number(data.quantity) * Number(data.unit_price);
  }

  const verdict = evaluateDiscount({
    rule: {
      maxPercent: Number(rule?.max_percent ?? 100),
      roleLimits: (rule?.role_limits ?? {}) as Record<string, number>,
      approvalThresholdPercent: rule?.approval_threshold_percent ?? null,
      requiresReason: Boolean(rule?.requires_reason ?? true),
    },
    roles,
    basis: input.basis,
    value: input.value,
    lineBase: base,
    reason: input.reason,
    platformAdmin: admin,
  });
  if (!verdict.allowed) throw new Error(verdict.message ?? "Discount not permitted.");

  if (item) {
    await sb
      .from("restaurant_order_items")
      .update({
        discount: verdict.amount,
        discount_rule_id: input.discountRuleId ?? null,
        discount_reason: input.reason ?? null,
        line_total: Number((base - verdict.amount).toFixed(2)),
      })
      .eq("id", item.id)
      .eq("tenant_id", input.tenantId);
  } else {
    await sb
      .from("restaurant_orders")
      .update({ discount_total: verdict.amount, total: Number((base - verdict.amount).toFixed(2)) })
      .eq("id", input.orderId)
      .eq("tenant_id", input.tenantId);
  }

  const { data: applied, error } = await sb
    .from("restaurant_discount_applications")
    .insert({
      tenant_id: input.tenantId,
      discount_rule_id: input.discountRuleId ?? null,
      order_id: input.orderId,
      order_item_id: input.orderItemId ?? null,
      scope: input.scope,
      basis: input.basis,
      value: input.value,
      amount: verdict.amount,
      currency: order.currency ?? "USD",
      reason: input.reason ?? null,
      actor_id: userId,
      actor_role: roles[0] ?? (admin ? "platform_admin" : null),
      approved_by: verdict.requiresApproval ? null : userId,
      approved_at: verdict.requiresApproval ? null : new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.discount.applied",
    tenantId: input.tenantId,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "order",
    entityId: input.orderId,
    payload: {
      amount: verdict.amount,
      percent: Number(verdict.percent.toFixed(2)),
      scope: input.scope,
      rule_code: rule?.code ?? null,
      requires_approval: verdict.requiresApproval,
    },
    source: "restaurant-pricing",
  });

  return {
    application: applied,
    requiresApproval: verdict.requiresApproval,
    percent: verdict.percent,
  };
}

/* ---------------- Promotions ---------------- */

export async function listPromotions(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listCommercialRulesSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_promotions")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("priority");
  if (input.activeOnly) q = q.eq("status", "active");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertPromotion(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertPromotionSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "pricing.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    code: input.code,
    name: input.name,
    description: input.description ?? null,
    action: input.action,
    value: input.value,
    currency: input.currency ?? null,
    applies_to_categories: input.appliesToCategories,
    applies_to_products: input.appliesToProducts,
    days_of_week: input.daysOfWeek,
    applies_to_channels: input.appliesToChannels,
    start_time: input.startTime ?? null,
    end_time: input.endTime ?? null,
    starts_at: input.startsAt ?? new Date().toISOString(),
    ends_at: input.endsAt ?? null,
    priority: input.priority,
    stackable: input.stackable,
    eligibility: input.eligibility,
    status: input.status,
    created_by: userId,
  };
  const q = input.id
    ? sb
        .from("restaurant_promotions")
        .update(row)
        .eq("id", input.id)
        .eq("tenant_id", input.tenantId)
    : sb.from("restaurant_promotions").insert(row);
  const { data, error } = await q.select("*").single();
  if (error) throw new Error(error.message);
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "promotion",
    entityId: data.id,
    action: "upsert",
    newValue: row,
  });
  return data;
}

export async function setPromotionStatus(
  sb: Sb,
  userId: string,
  input: z.infer<typeof setPromotionStatusSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "pricing.manage");
  const { data, error } = await sb
    .from("restaurant_promotions")
    .update({ status: input.status })
    .eq("id", input.promotionId)
    .eq("tenant_id", input.tenantId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "promotion",
    entityId: input.promotionId,
    action: `promotion.${input.status}`,
    newValue: { status: input.status },
    reason: input.reason ?? null,
  });
  if (input.status === "active" || input.status === "ended") {
    await emitRestaurantEvent(sb, userId, {
      type:
        input.status === "active" ? "restaurant.promotion.started" : "restaurant.promotion.ended",
      tenantId: input.tenantId,
      entityType: "promotion",
      entityId: input.promotionId,
      payload: { code: data.code, action: data.action, value: Number(data.value) },
      source: "restaurant-pricing",
    });
  }
  return data;
}

/* ---------------- Audit ---------------- */

export async function listPricingAudit(
  sb: Sb,
  userId: string,
  input: z.infer<typeof pricingAuditSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_pricing_audit")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.entityType) q = q.eq("entity_type", input.entityType);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/* ---------------- Price lists ---------------- */

/**
 * A price list is a named, effective-dated set of prices — Standard, Corporate,
 * Happy Hour, Staff. Items are not duplicated: the same product simply carries
 * an additional price row that points at the list.
 */
export async function listPriceLists(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listPriceListsSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_price_lists")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("priority")
    .order("code");
  if (input.activeOnly) q = q.eq("status", "active");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertPriceList(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertPriceListSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "pricing.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    code: input.code,
    name: input.name,
    description: input.description ?? null,
    currency: input.currency.toUpperCase(),
    channel: input.channel ?? null,
    priority: input.priority,
    status: input.status,
    is_default: input.isDefault,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_to: input.effectiveTo ?? null,
    created_by: userId,
  };
  const q = input.id
    ? sb
        .from("restaurant_price_lists")
        .update(row)
        .eq("id", input.id)
        .eq("tenant_id", input.tenantId)
    : sb.from("restaurant_price_lists").insert(row);
  const { data, error } = await q.select("*").single();
  if (error) throw new Error(error.message);
  // Exactly one default list keeps "which price applies" answerable.
  if (input.isDefault) {
    await sb
      .from("restaurant_price_lists")
      .update({ is_default: false })
      .eq("tenant_id", input.tenantId)
      .neq("id", data.id);
  }
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "price_list",
    entityId: data.id,
    action: input.id ? "price_list.updated" : "price_list.created",
    newValue: row,
  });
  await emitRestaurantEvent(sb, userId, {
    type: input.id ? "restaurant.price_list.updated" : "restaurant.price_list.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "price_list",
    entityId: data.id,
    source: "restaurant-pricing",
    payload: { code: data.code, status: data.status, channel: data.channel },
  });
  return data;
}

/* ---------------- Rounding policies ---------------- */

export async function listRoundingRules(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listRoundingRulesSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_rounding_rules")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("target")
    .order("code");
  if (input.activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertRoundingRule(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertRoundingRuleSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "pricing.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    code: input.code,
    name: input.name,
    target: input.target,
    mode: input.mode,
    increment: input.increment,
    decimals: input.decimals,
    currency: input.currency ? input.currency.toUpperCase() : null,
    channel: input.channel ?? null,
    active: input.active,
    effective_from: input.effectiveFrom ?? new Date().toISOString(),
    effective_to: input.effectiveTo ?? null,
    created_by: userId,
  };
  const q = input.id
    ? sb
        .from("restaurant_rounding_rules")
        .update(row)
        .eq("id", input.id)
        .eq("tenant_id", input.tenantId)
    : sb.from("restaurant_rounding_rules").insert(row);
  const { data, error } = await q.select("*").single();
  if (error) throw new Error(error.message);
  await audit(sb, userId, {
    tenantId: input.tenantId,
    entityType: "rounding_rule",
    entityId: data.id,
    action: input.id ? "rounding.updated" : "rounding.created",
    newValue: row,
  });
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.rounding_rule.changed",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "rounding_rule",
    entityId: data.id,
    source: "restaurant-pricing",
    payload: { target: data.target, mode: data.mode, increment: Number(data.increment) },
  });
  return data;
}
