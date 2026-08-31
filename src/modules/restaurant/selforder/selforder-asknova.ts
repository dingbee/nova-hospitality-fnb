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

/* -------------------------------------------------------------------------
 * GEP2 — proposed-basket operations. The model may additionally propose
 * "add"/"remove"/"set_quantity" operations against real catalogue items.
 * This is a second, independent checkpoint from validateNovaResponse above
 * (deliberately not folded into it, so every existing caller/test of
 * validateNovaResponse is untouched): nothing here ever trusts an item id,
 * quantity, or modifier name the model produced — every one is re-resolved
 * against the same real catalogue/basket data the server already has.
 * ---------------------------------------------------------------------- */

export type NovaOperationAction = "add" | "remove" | "set_quantity";

/** The current guest basket, as the client already represents it — only what's needed to resolve "remove"/"set_quantity" references. */
export type NovaBasketLine = { menuItemId: string; quantity: number };

/** A catalogue item projected with exactly what operation-resolution needs — never more than guestMenu() already returns. */
export type NovaResolvableItem = {
  id: string;
  name: string;
  available: boolean;
  priceConfigured: boolean;
  modifierGroupIds: string[];
};

export type NovaResolvableModifierGroup = {
  id: string;
  name: string;
  required: boolean;
  minSelect: number;
  modifiers: { name: string }[];
};

export type ResolvedNovaOperation =
  | {
      status: "applied";
      action: "add";
      itemId: string;
      name: string;
      quantity: number;
      modifierNames: string[];
    }
  | { status: "applied"; action: "remove"; itemId: string; name: string }
  | { status: "applied"; action: "set_quantity"; itemId: string; name: string; quantity: number }
  | { status: "unavailable"; itemId: string; name: string }
  | { status: "not_found"; itemId: string }
  | { status: "not_in_basket"; itemId: string; name: string }
  | {
      status: "needs_modifier";
      itemId: string;
      name: string;
      groupName: string;
      options: string[];
    };

const MAX_OPERATIONS_PER_TURN = 10;
const MAX_ADD_QUANTITY = 20;

function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Resolves the model's raw, untrusted `operations` array into operations
 * that are safe to actually apply to the basket — the sole gate between
 * "the model said X" and "the guest's basket changed". Silently drops any
 * operation with a malformed shape or an action that isn't one of the
 * three known kinds, exactly like validateNovaResponse silently drops an
 * invented item id — never guesses, never fabricates, never throws for
 * untrusted input.
 */
export function resolveNovaOperations(
  rawOperations: unknown,
  catalog: {
    items: readonly NovaResolvableItem[];
    modifierGroups: readonly NovaResolvableModifierGroup[];
  },
  basket: readonly NovaBasketLine[],
): ResolvedNovaOperation[] {
  if (!Array.isArray(rawOperations)) return [];
  const itemById = new Map(catalog.items.map((i) => [i.id, i]));
  const groupById = new Map(catalog.modifierGroups.map((g) => [g.id, g]));
  const basketByItemId = new Map(basket.map((l) => [l.menuItemId, l]));

  const results: ResolvedNovaOperation[] = [];
  for (const raw of rawOperations.slice(0, MAX_OPERATIONS_PER_TURN)) {
    if (!raw || typeof raw !== "object") continue;
    const op = raw as {
      action?: unknown;
      itemId?: unknown;
      quantity?: unknown;
      modifierNames?: unknown;
    };
    if (op.action !== "add" && op.action !== "remove" && op.action !== "set_quantity") continue;
    if (typeof op.itemId !== "string") continue;

    const item = itemById.get(op.itemId);
    if (!item) {
      results.push({ status: "not_found", itemId: op.itemId });
      continue;
    }

    if (op.action === "add") {
      if (!item.available || !item.priceConfigured) {
        results.push({ status: "unavailable", itemId: item.id, name: item.name });
        continue;
      }
      const rawQty = Number(op.quantity);
      const quantity = Number.isFinite(rawQty)
        ? Math.min(Math.max(Math.round(rawQty), 1), MAX_ADD_QUANTITY)
        : 1;

      const requestedNames = Array.isArray(op.modifierNames)
        ? op.modifierNames.filter((n): n is string => typeof n === "string")
        : [];
      const itemGroups = item.modifierGroupIds
        .map((gid) => groupById.get(gid))
        .filter((g): g is NovaResolvableModifierGroup => Boolean(g));

      // Only a name that actually exists somewhere among this item's own
      // groups is ever accepted — an unmatched name is dropped, never
      // fabricated into a real modifier.
      const resolvedNames: string[] = [];
      for (const group of itemGroups) {
        for (const modifier of group.modifiers) {
          if (requestedNames.some((n) => normalizeName(n) === normalizeName(modifier.name))) {
            resolvedNames.push(modifier.name);
          }
        }
      }

      const unmetRequired = itemGroups.find((g) => {
        if (!g.required || g.minSelect < 1) return false;
        const chosenInGroup = g.modifiers.filter((m) => resolvedNames.includes(m.name)).length;
        return chosenInGroup < g.minSelect;
      });
      if (unmetRequired) {
        results.push({
          status: "needs_modifier",
          itemId: item.id,
          name: item.name,
          groupName: unmetRequired.name,
          options: unmetRequired.modifiers.map((m) => m.name),
        });
        continue;
      }

      results.push({
        status: "applied",
        action: "add",
        itemId: item.id,
        name: item.name,
        quantity,
        modifierNames: resolvedNames,
      });
      continue;
    }

    // remove / set_quantity only ever target something genuinely already
    // in the guest's own basket — never inferred, never created.
    const inBasket = basketByItemId.get(item.id);
    if (!inBasket) {
      results.push({ status: "not_in_basket", itemId: item.id, name: item.name });
      continue;
    }

    if (op.action === "remove") {
      results.push({ status: "applied", action: "remove", itemId: item.id, name: item.name });
      continue;
    }

    // set_quantity
    const rawQty = Number(op.quantity);
    if (!Number.isFinite(rawQty) || rawQty < 1) continue;
    const quantity = Math.min(Math.round(rawQty), MAX_ADD_QUANTITY);
    results.push({
      status: "applied",
      action: "set_quantity",
      itemId: item.id,
      name: item.name,
      quantity,
    });
  }
  return results;
}
