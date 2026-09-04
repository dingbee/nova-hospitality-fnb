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
import type { SalesLineModifier } from "./sales.server";

type Sb = any;

/**
 * Pricing authority for modifiers on an untrusted (guest) line.
 *
 * A guest may identify a modifier by id; the name and price delta that
 * actually affect money are never taken from the request — they are always
 * read back from the modifier's own configured row, the same row the till's
 * own catalogue read (`fetchSellableCatalog`) shows the guest in the first
 * place. A modifier that does not exist, is inactive, or does not belong to
 * a group actually linked to this menu item's product is rejected outright
 * rather than silently dropped or silently repriced — the caller should
 * treat a thrown error here as "reject the whole line".
 *
 * Batched per menu item (not per line) so a 50-line guest order costs a
 * bounded number of queries, matching the batching style already used for
 * stations/costs/recipes earlier in insertLines.
 */
export async function resolveAuthoritativeModifiersForMenuItems(
  sb: Sb,
  tenantId: string,
  menuItemIds: string[],
): Promise<Map<string, Map<string, { groupId: string; name: string; priceDelta: number }>>> {
  const ids = [...new Set(menuItemIds)];
  const byMenuItem = new Map<
    string,
    Map<string, { groupId: string; name: string; priceDelta: number }>
  >();
  if (ids.length === 0) return byMenuItem;

  const { data: productRows } = await sb
    .from("restaurant_products")
    .select("id, menu_item_id")
    .eq("tenant_id", tenantId)
    .in("menu_item_id", ids);
  const productByMenuItem = new Map<string, string>(
    ((productRows ?? []) as any[]).map((p) => [p.menu_item_id, p.id]),
  );
  const productIds = [...new Set([...productByMenuItem.values()])];
  if (productIds.length === 0) {
    for (const id of ids) byMenuItem.set(id, new Map());
    return byMenuItem;
  }

  const { data: linkRows } = await sb
    .from("restaurant_product_modifier_groups")
    .select("product_id, group_id")
    .eq("tenant_id", tenantId)
    .in("product_id", productIds);
  const groupIdsByProduct = new Map<string, Set<string>>();
  for (const l of (linkRows ?? []) as any[]) {
    if (!groupIdsByProduct.has(l.product_id)) groupIdsByProduct.set(l.product_id, new Set());
    groupIdsByProduct.get(l.product_id)!.add(l.group_id);
  }
  const allGroupIds = [...new Set((linkRows ?? []).map((l: any) => l.group_id))];

  const { data: modifierRows } = allGroupIds.length
    ? await sb
        .from("restaurant_modifiers")
        .select("id, group_id, name, price_delta, active")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .in("group_id", allGroupIds)
    : { data: [] };
  const modifiersByGroup = new Map<string, any[]>();
  for (const m of (modifierRows ?? []) as any[]) {
    if (!modifiersByGroup.has(m.group_id)) modifiersByGroup.set(m.group_id, []);
    modifiersByGroup.get(m.group_id)!.push(m);
  }

  for (const menuItemId of ids) {
    const productId = productByMenuItem.get(menuItemId);
    const validModifiers = new Map<string, { groupId: string; name: string; priceDelta: number }>();
    const groupIds = productId
      ? (groupIdsByProduct.get(productId) ?? new Set<string>())
      : new Set<string>();
    for (const groupId of groupIds) {
      for (const m of modifiersByGroup.get(groupId) ?? []) {
        validModifiers.set(m.id, {
          groupId,
          name: m.name,
          priceDelta: Number(m.price_delta ?? 0),
        });
      }
    }
    byMenuItem.set(menuItemId, validModifiers);
  }
  return byMenuItem;
}

/**
 * Resolves one line's guest-supplied modifier selections against the
 * authoritative map above. Throws — never silently drops or reprices — on
 * any modifier that is unknown, inactive, or not actually offered on this
 * menu item, so an invalid selection fails the whole line loudly.
 */
export function resolveLineModifiersStrict(
  menuItemId: string | null | undefined,
  requested: { modifierId?: string; quantity?: number }[],
  validByMenuItem: Map<string, Map<string, { groupId: string; name: string; priceDelta: number }>>,
): SalesLineModifier[] {
  if (requested.length === 0) return [];
  if (!menuItemId) {
    throw new Error("Modifiers were supplied for a line with no catalogue item to attach them to.");
  }
  const valid = validByMenuItem.get(menuItemId) ?? new Map();
  return requested.map((r) => {
    if (!r.modifierId || !valid.has(r.modifierId)) {
      throw new Error("This modifier is not available for this item.");
    }
    const def = valid.get(r.modifierId)!;
    const quantity = Number(r.quantity ?? 1);
    return {
      modifierId: r.modifierId,
      groupId: def.groupId,
      name: def.name,
      priceDelta: def.priceDelta,
      quantity,
    };
  });
}

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
