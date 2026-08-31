import { describe, expect, it } from "vitest";
import {
  buildNovaCatalogContext,
  resolveNovaOperations,
  validateNovaResponse,
  type NovaResolvableItem,
  type NovaResolvableModifierGroup,
} from "./selforder-asknova";

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

describe("resolveNovaOperations", () => {
  const FISH: NovaResolvableItem = {
    id: "item-fish",
    name: "Grilled Fish",
    available: true,
    priceConfigured: true,
    modifierGroupIds: [],
  };
  const COKE: NovaResolvableItem = {
    id: "item-coke",
    name: "Coca-Cola",
    available: true,
    priceConfigured: true,
    modifierGroupIds: [],
  };
  const SOLD_OUT: NovaResolvableItem = {
    id: "item-soldout",
    name: "Chef's Special",
    available: false,
    priceConfigured: true,
    modifierGroupIds: [],
  };
  const UNPRICED: NovaResolvableItem = {
    id: "item-unpriced",
    name: "New Dish",
    available: true,
    priceConfigured: false,
    modifierGroupIds: [],
  };
  const STEAK_GROUP: NovaResolvableModifierGroup = {
    id: "group-doneness",
    name: "How would you like it cooked?",
    required: true,
    minSelect: 1,
    modifiers: [{ name: "Rare" }, { name: "Medium" }, { name: "Well done" }],
  };
  const CHEESE_GROUP: NovaResolvableModifierGroup = {
    id: "group-extras",
    name: "Extras",
    required: false,
    minSelect: 0,
    modifiers: [{ name: "Extra cheese" }, { name: "Bacon" }],
  };
  const STEAK: NovaResolvableItem = {
    id: "item-steak",
    name: "Sirloin Steak",
    available: true,
    priceConfigured: true,
    modifierGroupIds: [STEAK_GROUP.id, CHEESE_GROUP.id],
  };

  const CATALOG = {
    items: [FISH, COKE, SOLD_OUT, UNPRICED, STEAK],
    modifierGroups: [STEAK_GROUP, CHEESE_GROUP],
  };

  it("resolves a valid add operation against the real catalogue", () => {
    const result = resolveNovaOperations([{ action: "add", itemId: FISH.id }], CATALOG, []);
    expect(result).toEqual([
      {
        status: "applied",
        action: "add",
        itemId: FISH.id,
        name: FISH.name,
        quantity: 1,
        modifierNames: [],
      },
    ]);
  });

  it("defaults quantity to 1 and clamps an out-of-range quantity", () => {
    const result = resolveNovaOperations(
      [{ action: "add", itemId: COKE.id, quantity: 999 }],
      CATALOG,
      [],
    );
    expect(result[0]).toMatchObject({ status: "applied", action: "add", quantity: 20 });
  });

  it("rejects an add for an item id that doesn't exist in the catalogue — never guesses", () => {
    const result = resolveNovaOperations([{ action: "add", itemId: "invented-item" }], CATALOG, []);
    expect(result).toEqual([{ status: "not_found", itemId: "invented-item" }]);
  });

  it("rejects an add for an unavailable item", () => {
    const result = resolveNovaOperations([{ action: "add", itemId: SOLD_OUT.id }], CATALOG, []);
    expect(result).toEqual([{ status: "unavailable", itemId: SOLD_OUT.id, name: SOLD_OUT.name }]);
  });

  it("rejects an add for an item with no resolvable price", () => {
    const result = resolveNovaOperations([{ action: "add", itemId: UNPRICED.id }], CATALOG, []);
    expect(result).toEqual([{ status: "unavailable", itemId: UNPRICED.id, name: UNPRICED.name }]);
  });

  it("asks for a required modifier rather than fabricating a default", () => {
    const result = resolveNovaOperations([{ action: "add", itemId: STEAK.id }], CATALOG, []);
    expect(result).toEqual([
      {
        status: "needs_modifier",
        itemId: STEAK.id,
        name: STEAK.name,
        groupName: STEAK_GROUP.name,
        options: ["Rare", "Medium", "Well done"],
      },
    ]);
  });

  it("accepts an add once the required modifier is supplied by real, matching name", () => {
    const result = resolveNovaOperations(
      [{ action: "add", itemId: STEAK.id, modifierNames: ["medium"] }],
      CATALOG,
      [],
    );
    expect(result).toEqual([
      {
        status: "applied",
        action: "add",
        itemId: STEAK.id,
        name: STEAK.name,
        quantity: 1,
        modifierNames: ["Medium"],
      },
    ]);
  });

  it("never fabricates a modifier name that doesn't exist for this item", () => {
    const result = resolveNovaOperations(
      [{ action: "add", itemId: STEAK.id, modifierNames: ["Medium", "Truffle shavings"] }],
      CATALOG,
      [],
    );
    expect(result[0]).toMatchObject({ modifierNames: ["Medium"] });
  });

  it("removes an item that is genuinely present in the current basket", () => {
    const result = resolveNovaOperations([{ action: "remove", itemId: FISH.id }], CATALOG, [
      { menuItemId: FISH.id, quantity: 1 },
    ]);
    expect(result).toEqual([
      { status: "applied", action: "remove", itemId: FISH.id, name: FISH.name },
    ]);
  });

  it("refuses to remove an item that isn't actually in the basket", () => {
    const result = resolveNovaOperations([{ action: "remove", itemId: FISH.id }], CATALOG, []);
    expect(result).toEqual([{ status: "not_in_basket", itemId: FISH.id, name: FISH.name }]);
  });

  it("changes quantity for an item genuinely present in the basket", () => {
    const result = resolveNovaOperations(
      [{ action: "set_quantity", itemId: FISH.id, quantity: 3 }],
      CATALOG,
      [{ menuItemId: FISH.id, quantity: 1 }],
    );
    expect(result).toEqual([
      { status: "applied", action: "set_quantity", itemId: FISH.id, name: FISH.name, quantity: 3 },
    ]);
  });

  it("refuses set_quantity for an item not in the basket", () => {
    const result = resolveNovaOperations(
      [{ action: "set_quantity", itemId: FISH.id, quantity: 3 }],
      CATALOG,
      [],
    );
    expect(result).toEqual([{ status: "not_in_basket", itemId: FISH.id, name: FISH.name }]);
  });

  it("silently drops a malformed operation (unknown action, missing itemId) rather than throwing", () => {
    expect(resolveNovaOperations([{ action: "teleport", itemId: FISH.id }], CATALOG, [])).toEqual(
      [],
    );
    expect(resolveNovaOperations([{ action: "add" }], CATALOG, [])).toEqual([]);
    expect(resolveNovaOperations([{}], CATALOG, [])).toEqual([]);
    expect(resolveNovaOperations(null, CATALOG, [])).toEqual([]);
    expect(resolveNovaOperations("not an array", CATALOG, [])).toEqual([]);
  });

  it("caps the number of operations processed in a single turn", () => {
    const many = Array.from({ length: 25 }, () => ({ action: "add" as const, itemId: FISH.id }));
    const result = resolveNovaOperations(many, CATALOG, []);
    expect(result.length).toBe(10);
  });

  it("resolves multiple operations in one call, e.g. add a Coke while removing the fish", () => {
    const result = resolveNovaOperations(
      [
        { action: "add", itemId: COKE.id },
        { action: "remove", itemId: FISH.id },
      ],
      CATALOG,
      [{ menuItemId: FISH.id, quantity: 1 }],
    );
    expect(result).toEqual([
      {
        status: "applied",
        action: "add",
        itemId: COKE.id,
        name: COKE.name,
        quantity: 1,
        modifierNames: [],
      },
      { status: "applied", action: "remove", itemId: FISH.id, name: FISH.name },
    ]);
  });
});
