/**
 * Commercial rules test matrix. These are the guarantees the bill depends on:
 * if one of them breaks, guests are charged the wrong amount.
 */
import { describe, expect, it } from "vitest";
import {
  CommercialRuleError,
  quoteLine,
  resolveBasePrice,
  type ChargeRule,
  type PriceCandidate,
  type PriceListRule,
  type PricingContext,
  type PromotionRule,
  type RoundingRule,
} from "../engine";
import { add, applyRounding, mul } from "../decimal";

const AT = new Date("2026-06-01T12:00:00.000Z");

const price = (over: Partial<PriceCandidate> = {}): PriceCandidate => ({
  id: over.id ?? "p1",
  scope: "tenant",
  amount: 10_000,
  currency: "TZS",
  taxInclusive: false,
  version: 1,
  status: "active",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  propertyId: null,
  locationId: null,
  productId: "prod",
  variantId: null,
  menuItemId: "mi",
  priceListId: null,
  channel: null,
  ...over,
});

const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({
  at: AT,
  menuItemId: "mi",
  productId: "prod",
  quantity: 1,
  orderType: "dine_in",
  ...over,
});

const tax = (rate: number, inclusive = false): ChargeRule => ({
  id: "vat",
  code: "VAT",
  name: "VAT",
  basis: "percent",
  rate,
  fixedAmount: 0,
  inclusive,
  active: true,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  propertyId: null,
  locationId: null,
  products: [],
  categories: [],
});

const service = (rate: number, taxable = true): ChargeRule => ({
  id: "svc",
  code: "SVC",
  name: "Service charge",
  basis: "percent",
  rate,
  fixedAmount: 0,
  taxable,
  active: true,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  propertyId: null,
  locationId: null,
  products: [],
  categories: [],
});

const promo = (over: Partial<PromotionRule> = {}): PromotionRule => ({
  id: "promo",
  code: "HH",
  name: "Happy hour",
  action: "percent_discount",
  value: 20,
  status: "active",
  priority: 10,
  stackable: false,
  startsAt: "2026-01-01T00:00:00.000Z",
  endsAt: null,
  startTime: null,
  endTime: null,
  daysOfWeek: [],
  propertyId: null,
  locationId: null,
  products: [],
  categories: [],
  ...over,
});

const quote = (args: Parameters<typeof quoteLine>[0]) => quoteLine(args);

describe("decimal safety", () => {
  it("adds money without float drift", () => {
    expect(add(0.1, 0.2)).toBe(0.3);
    expect(mul(0.07, 3)).toBe(0.21);
  });

  it("rounds to a cash increment", () => {
    expect(applyRounding(10_237, { mode: "nearest", increment: 100, decimals: 0 })).toBe(10_200);
    expect(applyRounding(10_237, { mode: "up", increment: 100, decimals: 0 })).toBe(10_300);
    expect(applyRounding(10_237, { mode: "down", increment: 100, decimals: 0 })).toBe(10_200);
  });
});

describe("price resolution precedence", () => {
  it("prefers the outlet price over the tenant default", () => {
    const winner = resolveBasePrice(
      [
        price({ id: "tenant", amount: 10_000 }),
        price({ id: "outlet", scope: "location", locationId: "L1", amount: 12_000 }),
      ],
      ctx({ locationId: "L1" }),
    );
    expect(winner?.id).toBe("outlet");
  });

  it("prefers a channel-specific price over a general one", () => {
    const winner = resolveBasePrice(
      [price({ id: "any" }), price({ id: "delivery", channel: "delivery", amount: 13_000 })],
      ctx({ channel: "delivery" }),
    );
    expect(winner?.id).toBe("delivery");
  });

  it("ignores a price belonging to a list that is not in force", () => {
    const lists: PriceListRule[] = [
      {
        id: "corp",
        code: "CORP",
        name: "Corporate",
        currency: "TZS",
        channel: "corporate",
        priority: 10,
        status: "active",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: null,
        propertyId: null,
        locationId: null,
      },
    ];
    const candidates = [price({ id: "std" }), price({ id: "corp-price", priceListId: "corp", amount: 8_000 })];
    expect(resolveBasePrice(candidates, ctx({ channel: "dine_in" }), lists)?.id).toBe("std");
    expect(
      resolveBasePrice(candidates, ctx({ channel: "corporate", priceListIds: ["corp"] }), lists)?.id,
    ).toBe("corp-price");
  });

  it("prefers a variant price over the product-wide price", () => {
    const winner = resolveBasePrice(
      [price({ id: "base" }), price({ id: "large", variantId: "V1", amount: 14_000 })],
      ctx({ variantId: "V1" }),
    );
    expect(winner?.id).toBe("large");
  });

  it("refuses to guess between two equally valid, different prices", () => {
    expect(() =>
      resolveBasePrice([price({ id: "a", amount: 10_000 }), price({ id: "b", amount: 11_000 })], ctx()),
    ).toThrow(CommercialRuleError);
  });

  it("ignores prices outside their effective window", () => {
    const winner = resolveBasePrice(
      [price({ id: "expired", effectiveTo: "2026-02-01T00:00:00.000Z", amount: 9_000 })],
      ctx(),
    );
    expect(winner).toBeNull();
  });
});

describe("tax treatment", () => {
  it("adds exclusive tax on top", () => {
    const q = quote({ ctx: ctx(), prices: [price()], promotions: [], taxes: [tax(18)], serviceCharges: [] });
    expect(q.taxTotal).toBe(1_800);
    expect(q.lineTotal).toBe(11_800);
  });

  it("extracts inclusive tax from the displayed price", () => {
    const q = quote({
      ctx: ctx(),
      prices: [price({ taxInclusive: true })],
      promotions: [],
      taxes: [tax(18, true)],
      serviceCharges: [],
    });
    expect(q.lineTotal).toBe(10_000);
    expect(q.taxTotal).toBeCloseTo(1_525.42, 2);
    expect(q.lineNet).toBeCloseTo(8_474.58, 2);
  });

  it("taxes a taxable service charge", () => {
    const q = quote({
      ctx: ctx(),
      prices: [price()],
      promotions: [],
      taxes: [tax(18)],
      serviceCharges: [service(10)],
    });
    expect(q.serviceCharge).toBe(1_000);
    expect(q.taxTotal).toBe(1_980);
    expect(q.lineTotal).toBe(12_980);
  });
});

describe("promotions, discounts and modifiers", () => {
  it("applies a percentage promotion before quantity", () => {
    const q = quote({
      ctx: ctx({ quantity: 3 }),
      prices: [price()],
      promotions: [promo()],
      taxes: [],
      serviceCharges: [],
    });
    expect(q.unitPrice).toBe(8_000);
    expect(q.lineTotal).toBe(24_000);
    expect(q.promotionId).toBe("promo");
  });

  it("does not discount modifiers chosen by the guest", () => {
    const q = quote({
      ctx: ctx(),
      prices: [price()],
      promotions: [promo()],
      taxes: [],
      serviceCharges: [],
      modifiers: [{ name: "Extra cheese", priceDelta: 1_000, quantity: 1 }],
    });
    expect(q.modifierTotal).toBe(1_000);
    expect(q.lineTotal).toBe(9_000);
  });

  it("never lets a line discount push the line below zero", () => {
    const q = quote({
      ctx: ctx(),
      prices: [price()],
      promotions: [],
      taxes: [],
      serviceCharges: [],
      lineDiscount: 99_999,
    });
    expect(q.lineTotal).toBe(0);
  });
});

describe("rounding and failure behaviour", () => {
  const rounding: RoundingRule[] = [
    {
      id: "r1",
      code: "TZS-100",
      target: "line",
      mode: "nearest",
      increment: 100,
      decimals: 0,
      currency: null,
      channel: null,
      active: true,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      propertyId: null,
      locationId: null,
    },
  ];

  it("applies the configured line rounding and records the adjustment", () => {
    const q = quote({
      ctx: ctx(),
      prices: [price({ amount: 10_237 })],
      promotions: [],
      taxes: [],
      serviceCharges: [],
      roundingRules: rounding,
    });
    expect(q.lineTotal).toBe(10_200);
    expect(q.roundingAdjustment).toBe(-37);
  });

  it("blocks the sale when no price is configured", () => {
    expect(() =>
      quote({ ctx: ctx(), prices: [], promotions: [], taxes: [], serviceCharges: [] }),
    ).toThrow(CommercialRuleError);
  });

  it("explains every step it took", () => {
    const q = quote({
      ctx: ctx(),
      prices: [price()],
      promotions: [promo()],
      taxes: [tax(18)],
      serviceCharges: [service(10)],
    });
    expect(q.trace.map((t) => t.step)).toEqual([
      "base_price",
      "promotion",
      "service_charge",
      "tax",
      "line_total",
    ]);
  });
});
