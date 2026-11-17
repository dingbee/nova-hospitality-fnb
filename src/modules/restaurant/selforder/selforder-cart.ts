/**
 * Pure, client-side cart/selection logic for the self-order picker —
 * extracted out of the order.$tableId.tsx route so it's directly testable
 * without rendering React (this repo has no component-render test setup),
 * and so there is exactly one place this logic lives rather than one copy
 * in the component and a second reimplementation in a test.
 *
 * Nothing here talks to Supabase or the network. Every function is a pure
 * transform over data the route already fetched via guestMenuFn, or over
 * the guest's own in-memory cart. Mirrors the till's own PosItemDialog
 * logic (variant price derivation, modifier toggling) so the two surfaces
 * don't drift apart.
 */
import type { SalesLineModifier } from "../sales/sales.server";

/** Mirrors restaurant_product_variants exactly — no required/min/max-select column exists on this table, unlike modifier groups, so a variant is never mandatory by the data model. */
export type ProductVariant = {
  id: string;
  name: string;
  price: number;
  price_is_delta: boolean;
};

export type ModifierGroup = {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  required: boolean;
  modifiers: { id: string; group_id: string; name: string; price_delta: number }[];
};

/** One modifier group's chosen modifier ids, keyed by group id. */
export type ModifierSelection = Record<string, Set<string>>;

/**
 * The effective per-unit price once a variant is chosen — identical to
 * PosItemDialog's own derivation. A client-side display estimate only:
 * the line is still submitted with unitPrice 0; the server re-resolves
 * the authoritative price from variantId, same as everywhere else in
 * this codebase.
 */
export function resolveVariantUnitPrice(
  basePrice: number,
  variant: ProductVariant | undefined,
): number {
  if (!variant) return basePrice;
  return variant.price_is_delta
    ? basePrice + Number(variant.price ?? 0)
    : Number(variant.price ?? 0);
}

/**
 * Toggles one modifier within its group. A single-select group (max_select
 * <= 1) clears any prior pick when a new one is chosen; a multi-select
 * group refuses a new pick once max_select is reached.
 */
export function toggleModifierSelection(
  selected: ModifierSelection,
  group: ModifierGroup,
  modifierId: string,
): ModifierSelection {
  const current = new Set(selected[group.id] ?? []);
  const single = group.max_select <= 1;
  if (current.has(modifierId)) {
    current.delete(modifierId);
  } else {
    if (single) current.clear();
    else if (current.size >= group.max_select) return selected;
    current.add(modifierId);
  }
  return { ...selected, [group.id]: current };
}

/**
 * True when a required modifier group doesn't yet meet its own minimum
 * selection count. Variants are never checked here — no
 * restaurant_product_variants row carries a required/min-select column,
 * unlike modifier groups, so a variant selection is never enforced.
 */
export function isMissingRequiredModifiers(
  groups: ModifierGroup[],
  selected: ModifierSelection,
): boolean {
  return groups.some((g) => g.required && (selected[g.id]?.size ?? 0) < Math.max(1, g.min_select));
}

/**
 * GEP2 — turns the modifier names the server already resolved and validated
 * (selfnova.server.ts's ResolvedNovaOperation, via resolveNovaOperations)
 * into the same SalesLineModifier shape a manual ItemPicker selection
 * produces. This never trusts a name on its own: it only ever matches
 * against the real modifiers already present in `groups`, so a name that
 * doesn't resolve to a real modifier here is silently dropped, exactly like
 * a manual selection can never pick a modifier that doesn't exist.
 */
export function matchModifiersByName(
  groups: ModifierGroup[],
  names: string[],
): SalesLineModifier[] {
  const normalized = names.map((n) => n.trim().toLowerCase());
  return groups.flatMap((g) =>
    g.modifiers
      .filter((m) => normalized.includes(m.name.trim().toLowerCase()))
      .map((m) => ({
        modifierId: m.id,
        groupId: g.id,
        name: m.name,
        priceDelta: Number(m.price_delta ?? 0),
        quantity: 1,
      })),
  );
}

/** Expands the selected modifier ids into the SalesLineModifier shape the guest order path submits. */
export function buildChosenModifiers(
  groups: ModifierGroup[],
  selected: ModifierSelection,
): SalesLineModifier[] {
  return groups.flatMap((g) =>
    [...(selected[g.id] ?? [])].map((id) => {
      const m = g.modifiers.find((mm) => mm.id === id)!;
      return {
        modifierId: m.id,
        groupId: g.id,
        name: m.name,
        priceDelta: Number(m.price_delta ?? 0),
        quantity: 1,
      };
    }),
  );
}

/**
 * The exact shape submitGuestOrderFn receives for one cart line.
 * unitPrice/discount are always submitted as 0 — the server is the sole
 * pricing authority regardless of what a client sends, matching how
 * insertLines already treats the POS's own proposed unitPrice.
 */
export function toGuestOrderLine(line: {
  menuItemId: string;
  name: string;
  quantity: number;
  modifiers: SalesLineModifier[];
  variantId?: string;
  notes?: string;
}) {
  return {
    menuItemId: line.menuItemId,
    description: line.name,
    quantity: line.quantity,
    unitPrice: 0 as const,
    discount: 0 as const,
    modifiers: line.modifiers,
    variantId: line.variantId,
    notes: line.notes,
  };
}
