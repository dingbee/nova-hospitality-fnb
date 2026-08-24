/**
 * Ask NOVA — pure, DB-free grounding/validation logic, matching the same
 * pattern as selforder-tracking.ts / selforder-feedback.ts: a plain data
 * transform the server module calls, unit testable without a Supabase
 * client or a real AI call.
 *
 * The one rule everything here exists to enforce: NOVA may only ever be
 * shown as recommending an item that is actually in the table's sellable
 * catalogue, at the catalogue's own price — never at a price, availability,
 * ingredient or allergen the model asserts on its own.
 */

export type NovaCatalogItem = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  categoryId: string | null;
  /** Only ever what restaurant_menu_items.tags actually contains — never inferred. */
  tags: string[];
  /** Only ever what restaurant_menu_items.allergens actually contains — never inferred. */
  allergens: string[];
  variants: { name: string; priceDelta: number }[];
  modifierGroupNames: string[];
};

export type NovaCategory = { id: string; name: string };

/** Keeps the prompt compact (requirement 10) — a small F&B menu fits well under this; a larger one is simply truncated rather than blowing up context. */
export const MAX_CATALOG_ITEMS_FOR_AI = 80;

/** The compact, serializable projection sent to the model — nothing beyond what a guest could already see on the ordering screen (no internal ids beyond the ones the guest's own cart already uses, no cost/supplier/inventory data, because fetchSellableCatalog never returns those to begin with). */
export function buildNovaCatalogContext(catalog: {
  items: readonly NovaCatalogItem[];
  categories: readonly NovaCategory[];
}): { categories: NovaCategory[]; items: NovaCatalogItem[] } {
  return {
    categories: catalog.categories.map((c) => ({ id: c.id, name: c.name })),
    items: catalog.items.slice(0, MAX_CATALOG_ITEMS_FOR_AI),
  };
}

export type ValidatedNovaResponse = { reply: string; recommendedItemIds: string[] };

/**
 * The single checkpoint between whatever the model said and what a guest is
 * ever shown. Returns null (triggering the caller's fallback) for anything
 * that isn't a well-formed { reply: string, recommendedItemIds?: string[] }
 * object — a non-string reply, an empty reply, or a response that isn't an
 * object at all. `recommendedItemIds` is filtered to the catalogue's own
 * id set: an id the model invented, mistyped, or borrowed from a different
 * table's menu is silently dropped, never surfaced.
 */
export function validateNovaResponse(
  parsed: unknown,
  validItemIds: ReadonlySet<string>,
): ValidatedNovaResponse | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { reply?: unknown; recommendedItemIds?: unknown };
  if (typeof obj.reply !== "string") return null;
  const reply = obj.reply.trim();
  if (reply.length === 0) return null;

  const rawIds = Array.isArray(obj.recommendedItemIds) ? obj.recommendedItemIds : [];
  const recommendedItemIds = rawIds.filter(
    (id): id is string => typeof id === "string" && validItemIds.has(id),
  );

  return { reply: reply.slice(0, 2000), recommendedItemIds };
}
