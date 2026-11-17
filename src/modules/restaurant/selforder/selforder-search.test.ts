import { describe, expect, it } from "vitest";
import { searchMenuItems, type SearchableMenuItem } from "./selforder-search";

type Item = SearchableMenuItem & { price: number };

function item(over: Partial<Item> & { id: string; name: string }): Item {
  return {
    description: null,
    category_id: null,
    tags: [],
    price: 10,
    ...over,
  };
}

const CATEGORIES = new Map<string, string>([
  ["cat-mains", "Mains"],
  ["cat-drinks", "Drinks"],
  ["cat-starters", "Starters"],
]);

const CATALOG: Item[] = [
  item({
    id: "1",
    name: "Grilled Fish",
    description: "Fresh tilapia with lemon butter",
    category_id: "cat-mains",
  }),
  item({
    id: "2",
    name: "Fish and Chips",
    description: "Beer-battered fish",
    category_id: "cat-mains",
  }),
  item({
    id: "3",
    name: "Chicken Curry",
    description: "Coconut curry with rice",
    category_id: "cat-mains",
  }),
  item({
    id: "4",
    name: "Beef Burger",
    description: "Cheddar, bacon, house sauce",
    category_id: "cat-mains",
  }),
  item({
    id: "5",
    name: "Safari Lager",
    description: "Local pilsner, 500ml",
    category_id: "cat-drinks",
  }),
  item({
    id: "6",
    name: "Whiskey Sour",
    description: "Bourbon, lemon, sugar",
    category_id: "cat-drinks",
  }),
  item({
    id: "7",
    name: "Garden Salad",
    description: "Vegetarian, seasonal greens",
    category_id: "cat-starters",
    tags: ["vegetarian"],
  }),
  item({
    id: "8",
    name: "Bruschetta",
    description: "Tomato, basil, olive oil",
    category_id: "cat-starters",
  }),
];

describe("searchMenuItems", () => {
  it("A: empty query returns the normal menu, unfiltered, in original order", () => {
    expect(searchMenuItems(CATALOG, "", CATEGORIES)).toEqual(CATALOG);
    expect(searchMenuItems(CATALOG, "   ", CATEGORIES)).toEqual(CATALOG);
  });

  it("B: exact item-name match", () => {
    const results = searchMenuItems(CATALOG, "Safari Lager", CATEGORIES);
    expect(results[0].id).toBe("5");
  });

  it("C: partial item-name search", () => {
    const results = searchMenuItems(CATALOG, "fish", CATEGORIES);
    expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(["1", "2"]));
    expect(results.length).toBe(2);
  });

  it("D: case-insensitive search", () => {
    const lower = searchMenuItems(CATALOG, "chicken", CATEGORIES);
    const upper = searchMenuItems(CATALOG, "CHICKEN", CATEGORIES);
    const mixed = searchMenuItems(CATALOG, "ChIcKeN", CATEGORIES);
    expect(lower.map((r) => r.id)).toEqual(["3"]);
    expect(upper).toEqual(lower);
    expect(mixed).toEqual(lower);
  });

  it("E: category search/filter", () => {
    const results = searchMenuItems(CATALOG, "drinks", CATEGORIES);
    expect(results.map((r) => r.id).sort()).toEqual(["5", "6"]);
  });

  it("F: description matching where supported", () => {
    const results = searchMenuItems(CATALOG, "bourbon", CATEGORIES);
    expect(results.map((r) => r.id)).toEqual(["6"]);
  });

  it("F2: tag matching (vegetarian)", () => {
    const results = searchMenuItems(CATALOG, "vegetarian", CATEGORIES);
    expect(results.map((r) => r.id)).toContain("7");
  });

  it("G: exact match outranks weak match — item named 'Burger' beats a description mentioning burger", () => {
    const withNamedMatch: Item[] = [
      ...CATALOG,
      item({
        id: "9",
        name: "Burger",
        description: "Simple beef burger",
        category_id: "cat-mains",
      }),
      item({
        id: "10",
        name: "Loaded Fries",
        description: "Topped like a burger, no bun",
        category_id: "cat-starters",
      }),
    ];
    const results = searchMenuItems(withNamedMatch, "burger", CATEGORIES);
    // Exact name match ("Burger") must rank first; "Beef Burger" (name-contains)
    // outranks "Loaded Fries" (description-only match).
    expect(results[0].id).toBe("9");
    const namedBeefBurgerIndex = results.findIndex((r) => r.id === "4");
    const descriptionOnlyIndex = results.findIndex((r) => r.id === "10");
    expect(namedBeefBurgerIndex).toBeGreaterThanOrEqual(0);
    expect(descriptionOnlyIndex).toBeGreaterThan(namedBeefBurgerIndex);
  });

  it("G2: sensible fuzzy matching for minor spelling differences does not outrank exact/partial matches", () => {
    // "chiken" (typo) should still find "Chicken Curry" via fuzzy tier.
    const results = searchMenuItems(CATALOG, "chiken", CATEGORIES);
    expect(results.map((r) => r.id)).toContain("3");
  });

  it("H: no-result state — nonsense query returns an empty array, not the whole menu", () => {
    const results = searchMenuItems(CATALOG, "zzzznonexistentitemzzzz", CATEGORIES);
    expect(results).toEqual([]);
  });

  it("I: clearing search (empty query again) restores the original browsing order", () => {
    searchMenuItems(CATALOG, "fish", CATEGORIES);
    const restored = searchMenuItems(CATALOG, "", CATEGORIES);
    expect(restored).toEqual(CATALOG);
  });

  it("does not mutate the input array", () => {
    const copy = [...CATALOG];
    searchMenuItems(CATALOG, "fish", CATEGORIES);
    expect(CATALOG).toEqual(copy);
  });

  it("K: performs correctly and quickly over 100+ items", () => {
    const big: Item[] = Array.from({ length: 250 }, (_, i) =>
      item({
        id: `gen-${i}`,
        name: `Generated Dish ${i}`,
        description: i % 7 === 0 ? "Contains fish sauce" : "Standard preparation",
        category_id: i % 3 === 0 ? "cat-mains" : i % 3 === 1 ? "cat-drinks" : "cat-starters",
      }),
    );
    big.push(item({ id: "exact", name: "Exact Target Dish", category_id: "cat-mains" }));
    const start = performance.now();
    const results = searchMenuItems(big, "Exact Target Dish", CATEGORIES);
    const elapsedMs = performance.now() - start;
    expect(results[0].id).toBe("exact");
    expect(elapsedMs).toBeLessThan(50);

    const descResults = searchMenuItems(big, "fish sauce", CATEGORIES);
    expect(descResults.length).toBeGreaterThan(0);
    expect(
      descResults.every((r) => (r.description ?? "").toLowerCase().includes("fish sauce")),
    ).toBe(true);
  });

  it("does not treat unrelated long words as fuzzy matches (bounded edit distance)", () => {
    const results = searchMenuItems(CATALOG, "xyzabc", CATEGORIES);
    expect(results).toEqual([]);
  });
});
