/**
 * Pricing, Tax & Commercial Rules RPC surface (Sprint 5.4).
 * Thin wrappers only — validation here, tenant/capability guards in the server.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  applyDiscountSchema,
  commercialEvidenceSchema,
  decidePriceSchema,
  listCommercialRulesSchema,
  listCurrenciesSchema,
  listExchangeRatesSchema,
  listPricesSchema,
  listPriceListsSchema,
  listRoundingRulesSchema,
  pricingAuditSchema,
  pricingReadinessSchema,
  resolvePriceSchema,
  setPromotionStatusSchema,
  simulatePricingSchema,
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

export const listRestaurantPriceListsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listPriceListsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listPriceLists(context.supabase, context.userId, data);
  });

export const upsertRestaurantPriceListFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertPriceListSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.upsertPriceList(context.supabase, context.userId, data);
  });

export const listRestaurantRoundingRulesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listRoundingRulesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listRoundingRules(context.supabase, context.userId, data);
  });

export const upsertRestaurantRoundingRuleFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertRoundingRuleSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.upsertRoundingRule(context.supabase, context.userId, data);
  });

export const listRestaurantCurrenciesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCurrenciesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listCurrencies(context.supabase, context.userId, data);
  });

export const upsertRestaurantCurrencyFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertCurrencySchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.upsertCurrency(context.supabase, context.userId, data);
  });

export const listRestaurantExchangeRatesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listExchangeRatesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listExchangeRates(context.supabase, context.userId, data);
  });

export const upsertRestaurantExchangeRateFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertExchangeRateSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.upsertExchangeRate(context.supabase, context.userId, data);
  });

export const listRestaurantPricesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listPricesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listPrices(context.supabase, context.userId, data);
  });

export const upsertRestaurantPriceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertPriceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.upsertPrice(context.supabase, context.userId, data);
  });

export const decideRestaurantPriceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => decidePriceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.decidePrice(context.supabase, context.userId, data);
  });

export const listRestaurantTaxRulesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCommercialRulesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listTaxRules(context.supabase, context.userId, data);
  });

export const upsertRestaurantTaxRuleFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertTaxRuleSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.upsertTaxRule(context.supabase, context.userId, data);
  });

export const listRestaurantServiceChargesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCommercialRulesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listServiceCharges(context.supabase, context.userId, data);
  });

export const upsertRestaurantServiceChargeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertServiceChargeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.upsertServiceCharge(context.supabase, context.userId, data);
  });

export const listRestaurantDiscountRulesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCommercialRulesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listDiscountRules(context.supabase, context.userId, data);
  });

export const upsertRestaurantDiscountRuleFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertDiscountRuleSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.upsertDiscountRule(context.supabase, context.userId, data);
  });

export const applyRestaurantDiscountFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => applyDiscountSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.applyDiscount(context.supabase, context.userId, data);
  });

export const listRestaurantPromotionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listCommercialRulesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listPromotions(context.supabase, context.userId, data);
  });

export const upsertRestaurantPromotionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertPromotionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.upsertPromotion(context.supabase, context.userId, data);
  });

export const setRestaurantPromotionStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => setPromotionStatusSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.setPromotionStatus(context.supabase, context.userId, data);
  });

export const listRestaurantPricingAuditFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => pricingAuditSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./pricing.server");
    return mod.listPricingAudit(context.supabase, context.userId, data);
  });

export const resolveRestaurantPriceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => resolvePriceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./resolution.server");
    return mod.resolvePrice(context.supabase, context.userId, data);
  });

export const simulateRestaurantPricingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => simulatePricingSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./simulation.server");
    return mod.simulatePricing(context.supabase, context.userId, data);
  });

export const getRestaurantCommercialEvidenceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => commercialEvidenceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./evidence.server");
    return mod.commercialEvidence(context.supabase, context.userId, data);
  });

export const restaurantPricingReadinessFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => pricingReadinessSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./readiness.server");
    return mod.pricingReadiness(context.supabase, context.userId, data);
  });
