/**
 * Composed beverages — the pure part.
 *
 * A cocktail is not "a drink": it is a spirit, a mixer, a garnish and ice, each
 * with its own stock, cost and availability. This module turns a recipe graph
 * into a flat, per-serving bill of materials and answers the two questions a
 * bartender actually has: what goes in it, and how many can I still pour?
 */

export interface CompositionNodeInput {
  recipeId: string;
  lines: Array<{
    id: string;
    componentKind: "inventory_item" | "sub_recipe" | string;
    inventoryItemId?: string | null;
    subRecipeId?: string | null;
    quantity: number;
    unitId?: string | null;
    yieldPercent?: number | null;
    isOptional?: boolean | null;
  }>;
  /** Portions this recipe yields; 1 for a single-serve cocktail. */
  yieldQuantity: number;
  /** Set when a sub-recipe is batched and stocked as its own item. */
  producesInventoryItemId?: string | null;
}

export interface CompositionComponent {
  inventoryItemId: string;
  unitId: string | null;
  /** Quantity consumed for one sold serving, yield loss included. */
  quantityPerServing: number;
  optional: boolean;
  /** Recipe path, so a bartender can see where a component came from. */
  via: string[];
  key: string;
}

export class CircularCompositionError extends Error {
  constructor(readonly path: string[]) {
    super(`This recipe contains itself: ${path.join(" → ")}.`);
    this.name = "CircularCompositionError";
  }
}

const effectiveQty = (quantity: number, yieldPercent: number | null | undefined) => {
  const yp = Number(yieldPercent ?? 100);
  return Number(quantity || 0) / (yp > 0 ? yp / 100 : 1);
};

/**
 * Flattens a recipe (and any unstocked sub-recipes) into per-serving inventory
 * demand. Stocked sub-recipes stop the walk: they *are* the stock item.
 */
export function flattenComposition(
  rootRecipeId: string,
  graph: Map<string, CompositionNodeInput>,
  multiplier = 1,
  path: string[] = [],
  out: CompositionComponent[] = [],
): CompositionComponent[] {
  if (path.includes(rootRecipeId)) throw new CircularCompositionError([...path, rootRecipeId]);
  const node = graph.get(rootRecipeId);
  if (!node) return out;
  const perServing = multiplier / (Number(node.yieldQuantity ?? 1) || 1);

  for (const line of node.lines) {
    const qty = effectiveQty(line.quantity, line.yieldPercent) * perServing;
    if (qty <= 0) continue;
    if (line.componentKind === "sub_recipe" && line.subRecipeId) {
      const sub = graph.get(line.subRecipeId);
      if (sub?.producesInventoryItemId) {
        out.push({
          inventoryItemId: sub.producesInventoryItemId,
          unitId: line.unitId ?? null,
          quantityPerServing: qty,
          optional: Boolean(line.isOptional),
          via: [...path, rootRecipeId],
          key: `${rootRecipeId}:${line.id}`,
        });
      } else if (sub) {
        flattenComposition(sub.recipeId, graph, qty, [...path, rootRecipeId], out);
      }
      continue;
    }
    if (line.inventoryItemId) {
      out.push({
        inventoryItemId: line.inventoryItemId,
        unitId: line.unitId ?? null,
        quantityPerServing: qty,
        optional: Boolean(line.isOptional),
        via: [...path, rootRecipeId],
        key: `${rootRecipeId}:${line.id}`,
      });
    }
  }
  return out;
}

/** Merges repeated components (a spirit used twice) into one demand line. */
export function mergeComponents(components: CompositionComponent[]): CompositionComponent[] {
  const by = new Map<string, CompositionComponent>();
  for (const c of components) {
    const found = by.get(c.inventoryItemId);
    if (found) {
      found.quantityPerServing += c.quantityPerServing;
      found.optional = found.optional && c.optional;
    } else by.set(c.inventoryItemId, { ...c });
  }
  return [...by.values()];
}

export function compositionCost(
  components: CompositionComponent[],
  unitCost: (inventoryItemId: string) => number,
): number {
  const total = components.reduce((s, c) => s + c.quantityPerServing * (unitCost(c.inventoryItemId) || 0), 0);
  return Number(total.toFixed(4));
}

/**
 * How many servings the current stock supports. Optional components never cap
 * availability — a missing garnish does not stop the drink being sold.
 */
export function servingsAvailable(
  components: CompositionComponent[],
  onHand: (inventoryItemId: string) => number,
): number {
  const binding = components.filter((c) => !c.optional && c.quantityPerServing > 0);
  if (binding.length === 0) return Infinity;
  return binding.reduce((min, c) => {
    const possible = Math.floor((onHand(c.inventoryItemId) || 0) / c.quantityPerServing);
    return Math.min(min, Math.max(0, possible));
  }, Infinity);
}

/** The limiting ingredient — what the bar must requisition first. */
export function limitingComponent(
  components: CompositionComponent[],
  onHand: (inventoryItemId: string) => number,
): CompositionComponent | null {
  let worst: CompositionComponent | null = null;
  let worstServings = Infinity;
  for (const c of components) {
    if (c.optional || c.quantityPerServing <= 0) continue;
    const servings = (onHand(c.inventoryItemId) || 0) / c.quantityPerServing;
    if (servings < worstServings) {
      worstServings = servings;
      worst = c;
    }
  }
  return worst;
}
