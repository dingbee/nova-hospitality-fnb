/**
 * Bar lens — pure helpers that narrow the shared restaurant catalogue to a
 * beverage view. No second catalogue, no second pricing engine: the same rows,
 * filtered by category semantics.
 */
export const BEVERAGE_CATEGORY_HINTS = [
  "drink", "beverage", "bar", "spirit", "whisk", "vodka", "gin", "rum", "tequila", "liqueur",
  "wine", "beer", "cider", "cocktail", "mocktail", "soft", "juice", "water", "coffee", "tea",
  "mixer", "shot", "energy",
] as const;

export function isBeverageCategory(name: unknown): boolean {
  return typeof name === "string" && BEVERAGE_CATEGORY_HINTS.some((h) => name.toLowerCase().includes(h));
}

/** Beverage categories, or all of them when nothing is tagged as beverage. */
export function beverageCategories<T extends { name?: unknown }>(categories: readonly T[]): T[] {
  const bar = categories.filter((c) => isBeverageCategory(c.name));
  return bar.length > 0 ? bar : [];
}
