/**
 * Regression coverage for the class of bug reported live: a menu item
 * displayed at a price the order path then refused, because the display
 * read a different, un-validated column instead of asking the pricing
 * engine. resolveDisplayPrice is the single function both the POS
 * catalogue and the self-order menu now use for "what would insertLines
 * actually charge" — this file pins that it never fabricates an answer
 * insertLines wouldn't also give.
 */
import { describe, expect, it } from "vitest";
import { resolveDisplayPrice, quoteWithRuleSet, type CommercialRuleSet } from "./resolution.server";
import type { PriceCandidate, PricingContext } from "./engine";

const AT = new Date("2026-06-01T12:00:00.000Z");

const price = (over: Partial<PriceCandidate> = {}): PriceCandidate => ({
  id: over.id ?? "price-1",
  scope: "tenant",
  amount: 12_000,
  currency: "TZS",
  taxInclusive: false,
  version: 1,
  status: "active",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  propertyId: null,
  locationId: null,
  productId: null,
  variantId: null,
  menuItemId: "mi-1",
  priceListId: null,
  channel: null,
  ...over,
});

const rules = (prices: PriceCandidate[]): CommercialRuleSet => ({
  prices,
  promotions: [],
  taxes: [],
  serviceCharges: [],
  priceLists: [],
  roundingRules: [],
});

const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({
  at: AT,
  menuItemId: "mi-1",
  productId: null,
  quantity: 1,
  orderType: "dine_in",
  channel: "dine_in",
  ...over,
});

describe("resolveDisplayPrice", () => {
  it("returns the same amount/currency insertLines would charge, when a price is configured", () => {
    const rs = rules([price()]);
    expect(resolveDisplayPrice(rs, ctx())).toEqual({ amount: 12_000, currency: "TZS" });
  });

  it("returns null — never a stale or fabricated number — when no active price exists for this item", () => {
    // Exactly the observed defect: a menu item with rows everywhere except
    // restaurant_prices. There is nothing here for this menuItemId at all.
    const rs = rules([price({ menuItemId: "some-other-item" })]);
    expect(resolveDisplayPrice(rs, ctx())).toBeNull();
  });

  it("agrees with quoteWithRuleSet's strict refusal — display and order-time validation see the same absence", () => {
    const rs = rules([]);
    expect(resolveDisplayPrice(rs, ctx())).toBeNull();
    expect(() => quoteWithRuleSet(rs, ctx(), { strict: true })).toThrow(/no active price/i);
  });

  it("respects the same outlet scope insertLines resolves against — a location-scoped price for a different location is not visible here", () => {
    const rs = rules([price({ locationId: "loc-a" })]);
    expect(resolveDisplayPrice(rs, ctx({ locationId: "loc-b" }))).toBeNull();
    expect(resolveDisplayPrice(rs, ctx({ locationId: "loc-a" }))).toEqual({
      amount: 12_000,
      currency: "TZS",
    });
  });

  it("respects the same channel scope — a takeaway-only price does not make an item orderable dine-in", () => {
    const rs = rules([price({ channel: "takeaway" })]);
    expect(resolveDisplayPrice(rs, ctx({ channel: "dine_in" }))).toBeNull();
    expect(resolveDisplayPrice(rs, ctx({ channel: "takeaway" }))).toEqual({
      amount: 12_000,
      currency: "TZS",
    });
  });

  it("does not resolve a price for the wrong menu item, even when one exists in the rule set", () => {
    const rs = rules([price({ menuItemId: "mi-1", amount: 5_000 })]);
    expect(resolveDisplayPrice(rs, ctx({ menuItemId: "mi-2" }))).toBeNull();
  });
});
