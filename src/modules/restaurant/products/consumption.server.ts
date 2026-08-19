/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Recipe-driven POS consumption.
 *
 * The chain is deterministic: order line → pinned recipe version → components →
 * inventory. A sub-recipe that is itself produced and stocked (a batch of
 * burger sauce sitting in the cold room) is consumed as that stock item; a
 * sub-recipe with no stocked output is exploded into its own ingredients so
 * nothing escapes the ledger.
 *
 * Consumption happens once, on order close, and is idempotent by dedupe key —
 * voids and reversals therefore never create unexplained stock loss.
 */
import { insertMovement } from "../inventory/movements.server";
import { CircularRecipeError } from "./recipe-cost.server";

type Sb = any;

interface ExplodedLine {
  inventoryItemId: string;
  unitId: string | null;
  quantity: number;
  key: string;
}

/** Flattens a recipe into inventory demand for one sold unit. */
async function explode(
  sb: Sb,
  tenantId: string,
  recipeId: string,
  multiplier: number,
  path: string[],
  out: ExplodedLine[],
): Promise<void> {
  if (path.includes(recipeId)) throw new CircularRecipeError([...path, recipeId]);

  const { data: recipe } = await sb
    .from("restaurant_recipes")
    .select("id, yield_quantity")
    .eq("tenant_id", tenantId)
    .eq("id", recipeId)
    .single();
  if (!recipe) return;

  const { data: lines } = await sb
    .from("restaurant_recipe_lines")
    .select("id, component_kind, inventory_item_id, sub_recipe_id, quantity, unit_id, yield_percent")
    .eq("tenant_id", tenantId)
    .eq("recipe_id", recipeId);

  for (const line of ((lines ?? []) as any[])) {
    const yieldPercent = Number(line.yield_percent ?? 100);
    const effective = (Number(line.quantity ?? 0) / (yieldPercent > 0 ? yieldPercent / 100 : 1)) * multiplier;
    if (effective <= 0) continue;

    if (line.component_kind === "sub_recipe" && line.sub_recipe_id) {
      const { data: sub } = await sb
        .from("restaurant_recipes")
        .select("id, produces_inventory_item_id, yield_quantity")
        .eq("tenant_id", tenantId)
        .eq("id", line.sub_recipe_id)
        .single();
      if (sub?.produces_inventory_item_id) {
        out.push({
          inventoryItemId: sub.produces_inventory_item_id,
          unitId: line.unit_id ?? null,
          quantity: effective,
          key: `${recipeId}:${line.id}`,
        });
      } else if (sub) {
        const yieldQty = Number(sub.yield_quantity ?? 1) || 1;
        await explode(sb, tenantId, sub.id, effective / yieldQty, [...path, recipeId], out);
      }
      continue;
    }
    if (line.inventory_item_id) {
      out.push({
        inventoryItemId: line.inventory_item_id,
        unitId: line.unit_id ?? null,
        quantity: effective,
        key: `${recipeId}:${line.id}`,
      });
    }
  }
}

/**
 * Consumes the ingredients for a sold line against the recipe version pinned
 * on that line. Returns the actual cost posted to the ledger.
 */
export async function consumeForRecipeSale(
  sb: Sb,
  userId: string,
  args: {
    tenantId: string;
    propertyId?: string | null;
    locationId?: string | null;
    orderId: string;
    orderItemId: string;
    recipeId: string;
    quantity: number;
    occurredAt?: string;
  },
): Promise<number> {
  const demand: ExplodedLine[] = [];
  const { data: recipe } = await sb
    .from("restaurant_recipes")
    .select("id, yield_quantity")
    .eq("tenant_id", args.tenantId)
    .eq("id", args.recipeId)
    .single();
  if (!recipe) return 0;

  // A menu recipe yields "1 serving" by default; a yield > 1 means the recipe
  // makes several portions, so one sale consumes a fraction of it.
  const perServing = args.quantity / (Number(recipe.yield_quantity ?? 1) || 1);
  await explode(sb, args.tenantId, args.recipeId, perServing, [], demand);
  if (demand.length === 0) return 0;

  const ids = [...new Set(demand.map((d) => d.inventoryItemId))];
  const { data: items } = await sb
    .from("restaurant_inventory_items")
    .select("id, average_cost, currency, location_id, property_id")
    .in("id", ids);
  const meta = new Map<string, any>(((items ?? []) as any[]).map((r) => [r.id, r]));

  let actualCost = 0;
  for (const line of demand) {
    const info = meta.get(line.inventoryItemId);
    const unitCost = Number(info?.average_cost ?? 0);
    await insertMovement(sb, userId, {
      tenantId: args.tenantId,
      propertyId: args.propertyId ?? info?.property_id ?? null,
      locationId: args.locationId ?? info?.location_id ?? null,
      inventoryItemId: line.inventoryItemId,
      unitId: line.unitId,
      movementType: "consumption",
      quantity: -line.quantity,
      unitCost,
      currency: info?.currency ?? "TZS",
      reason: "Sales consumption",
      referenceType: "restaurant_order",
      referenceId: args.orderId,
      orderItemId: args.orderItemId,
      occurredAt: args.occurredAt,
      dedupeKey: `consume:${args.orderItemId}:${line.key}`,
    });
    actualCost += line.quantity * unitCost;
  }
  return Number(actualCost.toFixed(4));
}
