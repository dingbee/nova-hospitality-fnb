/**
 * Sprint 5.4 — Pricing, Tax & Commercial Rules contracts.
 *
 * Browser-safe. These schemas are the only shape the RPC surface accepts, and
 * they deliberately keep cost, base price, outlet price, promotion, discount,
 * tax and service charge as separate concepts — never one collapsed number.
 */
import { z } from "zod";

const uuid = z.string().uuid();
const money = z.number().finite();

export const PRICE_SCOPES = ["tenant", "property", "location"] as const;
export type PriceScope = (typeof PRICE_SCOPES)[number];

export const PRICE_STATUSES = [
  "draft",
  "pending_approval",
  "active",
  "superseded",
  "expired",
  "rejected",
] as const;
export type PriceStatus = (typeof PRICE_STATUSES)[number];

export const CHARGE_BASES = ["percent", "fixed"] as const;
export type ChargeBasis = (typeof CHARGE_BASES)[number];

export const DISCOUNT_SCOPES = ["order", "product", "category"] as const;
export type DiscountScope = (typeof DISCOUNT_SCOPES)[number];

export const PROMOTION_ACTIONS = [
  "percent_discount",
  "fixed_discount",
  "price_override",
  "percent_uplift",
] as const;
export type PromotionAction = (typeof PROMOTION_ACTIONS)[number];

export const PROMOTION_STATUSES = ["draft", "scheduled", "active", "ended", "cancelled"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/** Sales channels a commercial rule can be restricted to. */
export const SALES_CHANNELS = [
  "dine_in",
  "takeaway",
  "delivery",
  "room_charge",
  "event",
  "corporate",
] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export const PRICE_LIST_STATUSES = ["draft", "active", "archived"] as const;
export type PriceListStatus = (typeof PRICE_LIST_STATUSES)[number];

export const ROUNDING_TARGETS = ["line", "total", "payment"] as const;
export const ROUNDING_MODES = ["none", "nearest", "up", "down"] as const;

const tenantScope = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
});

/* ---------------- Price lists ---------------- */

export const upsertPriceListSchema = tenantScope.extend({
  id: uuid.optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  currency: z.string().min(3).max(8).default("TZS"),
  channel: z.enum(SALES_CHANNELS).nullish(),
  priority: z.number().int().default(100),
  status: z.enum(PRICE_LIST_STATUSES).default("draft"),
  isDefault: z.boolean().default(false),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().nullish(),
});
export type UpsertPriceListInput = z.infer<typeof upsertPriceListSchema>;

export const listPriceListsSchema = tenantScope.extend({
  activeOnly: z.boolean().default(false),
});

/* ---------------- Rounding policies ---------------- */

export const upsertRoundingRuleSchema = tenantScope.extend({
  id: uuid.optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  target: z.enum(ROUNDING_TARGETS).default("total"),
  mode: z.enum(ROUNDING_MODES).default("nearest"),
  increment: z.number().min(0).max(100000).default(0.01),
  decimals: z.number().int().min(0).max(6).default(2),
  currency: z.string().min(3).max(8).nullish(),
  channel: z.enum(SALES_CHANNELS).nullish(),
  active: z.boolean().default(true),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().nullish(),
});
export type UpsertRoundingRuleInput = z.infer<typeof upsertRoundingRuleSchema>;

export const listRoundingRulesSchema = tenantScope.extend({
  activeOnly: z.boolean().default(false),
});

/* ---------------- Currencies ---------------- */

export const upsertCurrencySchema = z.object({
  id: uuid.optional(),
  tenantId: uuid,
  code: z
    .string()
    .min(3)
    .max(8)
    .transform((s) => s.toUpperCase()),
  symbol: z.string().max(8).default(""),
  name: z.string().max(80).default(""),
  decimals: z.number().int().min(0).max(6).default(2),
  rounding: z.number().min(0).max(1000).default(0.01),
  isBase: z.boolean().default(false),
  active: z.boolean().default(true),
});
export const listCurrenciesSchema = z.object({
  tenantId: uuid,
  activeOnly: z.boolean().default(false),
});

/* ---------------- Exchange rates ---------------- */

export const upsertExchangeRateSchema = z.object({
  id: uuid.optional(),
  tenantId: uuid,
  baseCurrency: z.string().min(3).max(8),
  targetCurrency: z.string().min(3).max(8),
  rate: z.number().positive(),
  source: z.string().max(60).default("manual"),
  manualOverride: z.boolean().default(false),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().nullish(),
  note: z.string().max(500).optional(),
});
export const listExchangeRatesSchema = z.object({
  tenantId: uuid,
  baseCurrency: z.string().min(3).max(8).optional(),
  targetCurrency: z.string().min(3).max(8).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

/* ---------------- Prices ---------------- */

export const upsertPriceSchema = tenantScope.extend({
  productId: uuid.optional(),
  variantId: uuid.optional(),
  menuItemId: uuid.optional(),
  scope: z.enum(PRICE_SCOPES).default("tenant"),
  priceListId: uuid.nullish(),
  channel: z.enum(SALES_CHANNELS).nullish(),
  currency: z.string().min(3).max(8).default("USD"),
  amount: money.min(0),
  taxInclusive: z.boolean().default(false),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().nullish(),
  reason: z.string().max(500).optional(),
  /** When true the price lands as pending_approval instead of active. */
  requiresApproval: z.boolean().default(false),
  /** Publish immediately (supersedes the previous active price on the same scope). */
  activate: z.boolean().default(true),
});
export type UpsertPriceInput = z.infer<typeof upsertPriceSchema>;

export const listPricesSchema = tenantScope.extend({
  productId: uuid.optional(),
  menuItemId: uuid.optional(),
  priceListId: uuid.optional(),
  status: z.enum(PRICE_STATUSES).optional(),
  includeHistory: z.boolean().default(true),
  limit: z.number().int().min(1).max(500).default(200),
});

export const decidePriceSchema = z.object({
  tenantId: uuid,
  priceId: uuid,
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(500).optional(),
});

/* ---------------- Tax & service charges ---------------- */

export const upsertTaxRuleSchema = tenantScope.extend({
  id: uuid.optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  basis: z.enum(CHARGE_BASES).default("percent"),
  /** Percent expressed as a percentage, e.g. 18 for 18%. */
  rate: z.number().min(0).max(100).default(0),
  fixedAmount: money.min(0).default(0),
  inclusive: z.boolean().default(false),
  appliesToCategories: z.array(uuid).default([]),
  appliesToProducts: z.array(uuid).default([]),
  priority: z.number().int().default(100),
  compound: z.boolean().default(false),
  appliesToChannels: z.array(z.enum(SALES_CHANNELS)).default([]),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().nullish(),
  active: z.boolean().default(true),
});

export const upsertServiceChargeSchema = tenantScope.extend({
  id: uuid.optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  basis: z.enum(CHARGE_BASES).default("percent"),
  rate: z.number().min(0).max(100).default(0),
  fixedAmount: money.min(0).default(0),
  appliesToCategories: z.array(uuid).default([]),
  appliesToProducts: z.array(uuid).default([]),
  appliesToOrderTypes: z.array(z.string().max(40)).default([]),
  appliesToChannels: z.array(z.enum(SALES_CHANNELS)).default([]),
  taxable: z.boolean().default(false),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().nullish(),
  active: z.boolean().default(true),
});

/* ---------------- Discounts ---------------- */

export const upsertDiscountRuleSchema = tenantScope.extend({
  id: uuid.optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  scope: z.enum(DISCOUNT_SCOPES).default("order"),
  basis: z.enum(CHARGE_BASES).default("percent"),
  value: money.min(0).default(0),
  maxPercent: z.number().min(0).max(100).default(100),
  appliesToCategories: z.array(uuid).default([]),
  appliesToProducts: z.array(uuid).default([]),
  requiresReason: z.boolean().default(true),
  approvalThresholdPercent: z.number().min(0).max(100).nullish(),
  /** Per restaurant role ceilings, e.g. { bartender: 5, restaurant_manager: 20 }. */
  roleLimits: z.record(z.string(), z.number().min(0).max(100)).default({}),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().nullish(),
  active: z.boolean().default(true),
});

export const applyDiscountSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  orderItemId: uuid.optional(),
  discountRuleId: uuid.optional(),
  scope: z.enum(DISCOUNT_SCOPES).default("order"),
  basis: z.enum(CHARGE_BASES).default("percent"),
  value: money.min(0),
  reason: z.string().max(500).optional(),
});
export type ApplyDiscountInput = z.infer<typeof applyDiscountSchema>;

/* ---------------- Promotions ---------------- */

export const upsertPromotionSchema = tenantScope.extend({
  id: uuid.optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  action: z.enum(PROMOTION_ACTIONS).default("percent_discount"),
  value: money.min(0).default(0),
  currency: z.string().min(3).max(8).nullish(),
  appliesToCategories: z.array(uuid).default([]),
  appliesToProducts: z.array(uuid).default([]),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  appliesToChannels: z.array(z.enum(SALES_CHANNELS)).default([]),
  startTime: z.string().nullish(),
  endTime: z.string().nullish(),
  startsAt: z.string().optional(),
  endsAt: z.string().nullish(),
  priority: z.number().int().default(100),
  stackable: z.boolean().default(false),
  eligibility: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(PROMOTION_STATUSES).default("draft"),
});

export const setPromotionStatusSchema = z.object({
  tenantId: uuid,
  promotionId: uuid,
  status: z.enum(PROMOTION_STATUSES),
  reason: z.string().max(500).optional(),
});

export const listCommercialRulesSchema = tenantScope.extend({
  activeOnly: z.boolean().default(false),
});

/* ---------------- Resolution & simulation ---------------- */

export const resolvePriceSchema = tenantScope.extend({
  menuItemId: uuid.optional(),
  productId: uuid.optional(),
  variantId: uuid.optional(),
  categoryId: uuid.optional(),
  quantity: z.number().min(0.001).default(1),
  orderType: z.string().max(40).default("dine_in"),
  channel: z.enum(SALES_CHANNELS).optional(),
  priceListIds: z.array(uuid).default([]),
  currency: z.string().min(3).max(8).optional(),
  at: z.string().optional(),
});
export type ResolvePriceInput = z.infer<typeof resolvePriceSchema>;

export const simulatePricingSchema = tenantScope.extend({
  /** Percentage change applied to the resolved base price, e.g. 8 for +8%. */
  changePercent: z.number().min(-90).max(500),
  categoryIds: z.array(uuid).default([]),
  menuItemIds: z.array(uuid).default([]),
  /** Assumed demand elasticity used for the illustrative volume effect. */
  elasticity: z.number().min(-5).max(0).default(-0.6),
  lookbackDays: z.number().int().min(7).max(365).default(30),
});
export type SimulatePricingInput = z.infer<typeof simulatePricingSchema>;

export const pricingAuditSchema = tenantScope.extend({
  entityType: z.string().max(60).optional(),
  limit: z.number().int().min(1).max(300).default(100),
});

export const commercialEvidenceSchema = tenantScope.extend({
  lookbackDays: z.number().int().min(1).max(365).default(30),
});

/** Commercial readiness audit — read-only, mirrors the POS pricing contract. */
export const pricingReadinessSchema = z.object({
  tenantId: z.string().uuid(),
  channel: z.string().min(1).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
