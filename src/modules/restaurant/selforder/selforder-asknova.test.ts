import { describe, expect, it } from "vitest";
import { buildNovaCatalogContext, validateNovaResponse } from "./selforder-asknova";

const BURGER = {
  id: "item-1",
  name: "Beef Burger",
  description: "Grilled beef patty, cheddar, lettuce",
  price: 12000,
  currency: "TZS",
  categoryId: "cat-mains",
  tags: ["popular-with-guests"],
  allergens: ["gluten", "dairy"],
  variants: [{ name: "Double patty", priceDelta: 3000 }],
  modifierGroupNames: ["Choice of side"],
};
const SALAD = {
  id: "item-2",
  name: "Garden Salad",
  description: "Seasonal greens, vinaigrette",
  price: 8000,
  currency: "TZS",
  categoryId: "cat-starters",
  tags: ["vegetarian", "vegan"],
  allergens: [],
  variants: [],
  modifierGroupNames: [],
};
const CATEGORIES = [
  { id: "cat-mains", name: "Mains" },
  { id: "cat-starters", name: "Starters" },
];

describe("buildNovaCatalogContext", () => {
  it("passes categories and items through unchanged for a normal-sized catalogue", () => {
    const ctx = buildNovaCatalogContext({ items: [BURGER, SALAD], categories: CATEGORIES });
    expect(ctx.categories).toEqual(CATEGORIES);
    expect(ctx.items).toEqual([BURGER, SALAD]);
  });

  it("truncates an oversized catalogue rather than growing the prompt without bound", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...BURGER, id: `item-${i}` }));
    const ctx = buildNovaCatalogContext({ items: many, categories: CATEGORIES });
    expect(ctx.items.length).toBe(80);
  });
});

describe("validateNovaResponse", () => {
  const VALID_IDS = new Set(["item-1", "item-2"]);

  it("accepts a well-formed response and keeps only real catalogue ids", () => {
    const result = validateNovaResponse(
      { reply: "The Beef Burger is a great filling option.", recommendedItemIds: ["item-1"] },
      VALID_IDS,
    );
    expect(result).toEqual({
      reply: "The Beef Burger is a great filling option.",
      recommendedItemIds: ["item-1"],
    });
  });

  it("discards a recommended id that isn't in the actual sellable catalogue", () => {
    const result = validateNovaResponse(
      { reply: "Try our special!", recommendedItemIds: ["item-1", "invented-item-99"] },
      VALID_IDS,
    );
    expect(result).toEqual({ reply: "Try our special!", recommendedItemIds: ["item-1"] });
  });

  it("returns no recommendations when every id is fabricated, but keeps the reply", () => {
    const result = validateNovaResponse(
      { reply: "We have a lovely pasta dish.", recommendedItemIds: ["fake-1", "fake-2"] },
      VALID_IDS,
    );
    expect(result).toEqual({ reply: "We have a lovely pasta dish.", recommendedItemIds: [] });
  });

  it("treats a missing recommendedItemIds field as no recommendations, not an error", () => {
    const result = validateNovaResponse({ reply: "Happy to help you decide!" }, VALID_IDS);
    expect(result).toEqual({ reply: "Happy to help you decide!", recommendedItemIds: [] });
  });

  it("rejects a non-string reply", () => {
    expect(validateNovaResponse({ reply: 42, recommendedItemIds: [] }, VALID_IDS)).toBeNull();
  });

  it("rejects an empty or whitespace-only reply", () => {
    expect(validateNovaResponse({ reply: "   " }, VALID_IDS)).toBeNull();
  });

  it("rejects a response that isn't an object at all", () => {
    expect(validateNovaResponse("just a string", VALID_IDS)).toBeNull();
    expect(validateNovaResponse(null, VALID_IDS)).toBeNull();
    expect(validateNovaResponse(42, VALID_IDS)).toBeNull();
    expect(validateNovaResponse(["array", "not", "object"], VALID_IDS)).toBeNull();
  });

  it("ignores a recommendedItemIds entry that isn't a string", () => {
    const result = validateNovaResponse(
      { reply: "Sure!", recommendedItemIds: ["item-1", 42, null, { id: "item-2" }] },
      VALID_IDS,
    );
    expect(result).toEqual({ reply: "Sure!", recommendedItemIds: ["item-1"] });
  });

  it("caps an excessively long reply rather than passing it through unbounded", () => {
    const huge = "x".repeat(5000);
    const result = validateNovaResponse({ reply: huge }, VALID_IDS);
    expect(result?.reply.length).toBe(2000);
  });
});
