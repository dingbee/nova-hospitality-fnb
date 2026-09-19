import type { PosModifierInput } from "../pos.contracts";

/**
 * Till-side pricing preview — pure math shared by every place a guest's
 * choice needs a live price before the server re-resolves it on send
 * (PosItemDialog's dialog, the mobile item sheet, PosPaymentDialog's pad).
 * Nothing here writes or is authoritative: the server always recomputes
 * price, tax and totals on `addPosLines`/`takePosPayment`.
 */

export function resolveUnitPrice(
  item: { price?: number | null },
  variant: { price?: number | null; price_is_delta?: boolean } | undefined,
): number {
  const basePrice = Number(item.price ?? 0);
  if (!variant) return basePrice;
  return variant.price_is_delta ? basePrice + Number(variant.price ?? 0) : Number(variant.price ?? 0);
}

export function modifierTotalPerUnit(modifiers: PosModifierInput[]): number {
  return modifiers.reduce((s, m) => s + m.priceDelta * m.quantity, 0);
}

/** The first required modifier group that doesn't yet meet its minimum selection, if any. */
export function firstUnmetRequiredGroup<
  G extends { id: string; required?: boolean; min_select?: number },
>(groups: G[], chosen: { groupId?: string }[]): G | undefined {
  return groups.find(
    (g) =>
      g.required &&
      chosen.filter((m) => m.groupId === g.id).length < Math.max(1, Number(g.min_select ?? 1)),
  );
}

/** Round-number notes a cashier is actually handed, above the amount due. */
export function quickTenders(balance: number): number[] {
  const steps = [1_000, 5_000, 10_000, 20_000, 50_000, 100_000];
  const rounded = new Set<number>();
  for (const step of steps) {
    const up = Math.ceil(balance / step) * step;
    if (up > 0 && up >= balance) rounded.add(up);
  }
  return [...rounded].sort((a, b) => a - b).slice(0, 4);
}
