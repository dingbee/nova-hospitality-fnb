/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Modifier consumption.
 *
 * A modifier that adds stock ("extra shot", "double cheese") must leave the
 * same ledger trail as the dish itself, otherwise the theoretical-vs-actual
 * variance quietly absorbs it. Consumption is idempotent by dedupe key, so
 * re-closing an order never double-deducts.
 */
import { insertMovement } from "../inventory/movements.server";
import { componentToStock, type UnitRow } from "../inventory/units";
import { consumeForRecipeSale } from "../products/consumption.server";

type Sb = any;

export async function consumeLineModifiers(
  sb: Sb,
  userId: string,
  args: {
    tenantId: string;
    propertyId?: string | null;
    locationId?: string | null;
    orderId: string;
    orderItemId: string;
    quantity: number;
    modifiers: { modifierId?: string; quantity?: number }[];
    occurredAt?: string;
  },
): Promise<number> {
  const ids = [...new Set(args.modifiers.map((m) => m.modifierId).filter(Boolean))] as string[];
  if (ids.length === 0) return 0;

  const { data: rows } = await sb
    .from("restaurant_modifiers")
    .select("id, name, effect, inventory_item_id, recipe_id, quantity, unit_id")
    .eq("tenant_id", args.tenantId)
    .in("id", ids);
  const defs = new Map<string, any>(((rows ?? []) as any[]).map((r) => [r.id, r]));

  let cost = 0;
  for (const chosen of args.modifiers) {
    const def = chosen.modifierId ? defs.get(chosen.modifierId) : null;
    if (!def || def.effect === "none") continue;
    const units = Number(chosen.quantity ?? 1) * args.quantity;

    if (def.effect === "recipe" && def.recipe_id) {
      cost += await consumeForRecipeSale(sb, userId, {
        tenantId: args.tenantId,
        propertyId: args.propertyId,
        locationId: args.locationId,
        orderId: args.orderId,
        orderItemId: args.orderItemId,
        recipeId: def.recipe_id,
        quantity: units,
        occurredAt: args.occurredAt,
      });
      continue;
    }

    if (def.effect === "inventory" && def.inventory_item_id) {
      const demand = Number(def.quantity ?? 1) * units;
      if (demand <= 0) continue;
      const { data: item } = await sb
        .from("restaurant_inventory_items")
        .select("id, name, average_cost, currency, location_id, property_id, unit_id")
        .eq("id", def.inventory_item_id)
        .single();
      const unitCost = Number(item?.average_cost ?? 0);

      // average_cost is priced per the item's own stock unit — a modifier
      // written in a different unit must be converted to stock units before
      // it is costed or deducted (see units.ts#componentToStock).
      let unitById = new Map<string, UnitRow>();
      if (def.unit_id && item?.unit_id && def.unit_id !== item.unit_id) {
        const { data: unitRows } = await sb
          .from("restaurant_inventory_units")
          .select("id, code, name, dimension, factor, base_unit_id")
          .in("id", [def.unit_id, item.unit_id]);
        unitById = new Map(((unitRows ?? []) as UnitRow[]).map((u) => [u.id, u]));
      }
      const converted = componentToStock(demand, def.unit_id, item ?? {}, unitById);
      if (!converted.exact) {
        throw new Error(
          `"${item?.name ?? def.name}": modifier "${def.name}" is in a unit that cannot be converted to this item's stock unit (${converted.reason ?? "unknown conversion"}). Fix the modifier's unit, or the item's stock unit, before this order can close.`,
        );
      }

      await insertMovement(sb, userId, {
        tenantId: args.tenantId,
        propertyId: args.propertyId ?? item?.property_id ?? null,
        locationId: args.locationId ?? item?.location_id ?? null,
        inventoryItemId: def.inventory_item_id,
        unitId: item?.unit_id ?? def.unit_id ?? null,
        movementType: "consumption",
        quantity: -converted.quantity,
        unitCost,
        currency: item?.currency ?? "TZS",
        reason: `Modifier: ${def.name}`,
        referenceType: "restaurant_order",
        referenceId: args.orderId,
        orderItemId: args.orderItemId,
        occurredAt: args.occurredAt,
        dedupeKey: `consume-mod:${args.orderItemId}:${def.id}`,
      });
      cost += converted.quantity * unitCost;
    }
  }
  return Number(cost.toFixed(4));
}
