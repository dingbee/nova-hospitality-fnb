/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Stock positions — item × location.
 *
 * Every quantity here is *derived*: on hand comes from the ledger view,
 * reserved from active reservations, incoming from open procurement.
 * Nothing in this file writes a balance.
 */
import { assertTenantRead } from "../core/access.server";
import { locationNameMap } from "./locations.server";
import type { LocationPosition, StockPosition, StockPositionsInput } from "./contracts";

type Sb = any;

const OPEN_PO_STATUSES = ["submitted", "approved", "partially_received"];

/** Active reservations grouped by item and by item+location. */
async function reservationIndex(sb: Sb, tenantId: string) {
  const { data } = await sb
    .from("restaurant_stock_reservations")
    .select("inventory_item_id, location_id, quantity")
    .eq("tenant_id", tenantId)
    .eq("status", "active");
  const byItem = new Map<string, number>();
  const byItemLocation = new Map<string, number>();
  for (const r of (data ?? []) as any[]) {
    const q = Number(r.quantity ?? 0);
    byItem.set(r.inventory_item_id, (byItem.get(r.inventory_item_id) ?? 0) + q);
    const key = `${r.inventory_item_id}:${r.location_id ?? "none"}`;
    byItemLocation.set(key, (byItemLocation.get(key) ?? 0) + q);
  }
  return { byItem, byItemLocation };
}

/** Quantity expected from open purchase orders (ordered minus received). */
export async function incomingIndex(sb: Sb, tenantId: string): Promise<Map<string, number>> {
  const { data: orders } = await sb
    .from("restaurant_purchase_orders")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .in("status", OPEN_PO_STATUSES);
  const ids = ((orders ?? []) as any[]).map((o) => o.id);
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const { data: lines } = await sb
    .from("restaurant_purchase_order_items")
    .select("inventory_item_id, quantity, received_quantity")
    .in("purchase_order_id", ids);
  for (const l of (lines ?? []) as any[]) {
    if (!l.inventory_item_id) continue;
    const outstanding = Number(l.quantity ?? 0) - Number(l.received_quantity ?? 0);
    if (outstanding <= 0) continue;
    map.set(l.inventory_item_id, (map.get(l.inventory_item_id) ?? 0) + outstanding);
  }
  return map;
}

export async function listStockPositions(
  sb: Sb,
  userId: string,
  input: StockPositionsInput,
): Promise<StockPosition[]> {
  await assertTenantRead(sb, userId, input.tenantId);

  let itemQuery = sb
    .from("restaurant_inventory_items")
    .select(
      "id, name, sku, category_id, unit_id, currency, average_cost, current_quantity, reorder_point, par_level, track_batches, allow_negative, status",
    )
    .eq("tenant_id", input.tenantId)
    .order("name")
    .limit(input.limit);
  if (input.propertyId) itemQuery = itemQuery.eq("property_id", input.propertyId);
  if (input.categoryId) itemQuery = itemQuery.eq("category_id", input.categoryId);
  if (input.itemId) itemQuery = itemQuery.eq("id", input.itemId);
  if (input.search) itemQuery = itemQuery.ilike("name", `%${input.search}%`);

  const [{ data: items, error }, { data: ledger }, reservations, incoming, locations] = await Promise.all([
    itemQuery,
    sb
      .from("restaurant_stock_positions_v")
      .select("inventory_item_id, location_id, on_hand, last_movement_at")
      .eq("tenant_id", input.tenantId),
    reservationIndex(sb, input.tenantId),
    incomingIndex(sb, input.tenantId),
    locationNameMap(sb, input.tenantId),
  ]);
  if (error) throw new Error(error.message);

  const byItem = new Map<string, any[]>();
  for (const row of (ledger ?? []) as any[]) {
    if (input.locationId && row.location_id !== input.locationId) continue;
    if (!byItem.has(row.inventory_item_id)) byItem.set(row.inventory_item_id, []);
    byItem.get(row.inventory_item_id)!.push(row);
  }

  const positions = ((items ?? []) as any[]).map((item) => {
    const rows = byItem.get(item.id) ?? [];
    const locationPositions: LocationPosition[] = rows
      .map((r) => {
        const onHand = Number(r.on_hand ?? 0);
        const reserved = reservations.byItemLocation.get(`${item.id}:${r.location_id ?? "none"}`) ?? 0;
        return {
          locationId: r.location_id ?? null,
          locationName: r.location_id ? (locations.get(r.location_id) ?? "Unknown location") : "Unassigned",
          onHand,
          reserved,
          available: onHand - reserved,
          lastMovementAt: r.last_movement_at ?? null,
        };
      })
      .sort((a, b) => b.onHand - a.onHand);

    // When a location filter is applied the position is that location's slice;
    // otherwise the ledger total, which must agree with the item balance.
    const onHand = input.locationId
      ? locationPositions.reduce((s, l) => s + l.onHand, 0)
      : Number(item.current_quantity ?? 0);
    const reserved = input.locationId
      ? locationPositions.reduce((s, l) => s + l.reserved, 0)
      : (reservations.byItem.get(item.id) ?? 0);
    const averageCost = Number(item.average_cost ?? 0);
    const reorderPoint = item.reorder_point == null ? null : Number(item.reorder_point);
    const available = onHand - reserved;

    return {
      itemId: item.id,
      name: item.name,
      sku: item.sku ?? null,
      categoryId: item.category_id ?? null,
      unitId: item.unit_id ?? null,
      currency: item.currency ?? "TZS",
      averageCost,
      onHand,
      reserved,
      available,
      incoming: incoming.get(item.id) ?? 0,
      value: Number((onHand * averageCost).toFixed(2)),
      reorderPoint,
      parLevel: item.par_level == null ? null : Number(item.par_level),
      low: reorderPoint != null && available <= reorderPoint,
      critical: available <= 0 || (reorderPoint != null && available <= reorderPoint / 2),
      trackBatches: Boolean(item.track_batches),
      allowNegative: Boolean(item.allow_negative),
      lastMovementAt:
        locationPositions.map((l) => l.lastMovementAt).filter(Boolean).sort().slice(-1)[0] ?? null,
      locations: locationPositions,
    } satisfies StockPosition;
  });

  return input.lowOnly ? positions.filter((p) => p.low) : positions;
}

/** Everything an inventory manager needs about one item, on one screen. */
export async function getItemDetail(sb: Sb, userId: string, tenantId: string, itemId: string) {
  await assertTenantRead(sb, userId, tenantId);

  const [positions, movements, batches, reservations, recipes, supplierPrices, openOrders] =
    await Promise.all([
      listStockPositions(sb, userId, {
        tenantId,
        itemId,
        lowOnly: false,
        limit: 1,
      } as StockPositionsInput),
      sb
        .from("restaurant_stock_movements")
        .select(
          "id, movement_type, quantity, unit_cost, total_cost, balance_after, location_id, destination_location_id, reason, reason_code, notes, occurred_at, reference_type, reference_id, transfer_id, stocktake_id, reversal_of_id",
        )
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId)
        .order("occurred_at", { ascending: false })
        .limit(120),
      sb
        .from("restaurant_inventory_batches")
        .select("id, batch_number, expiry_date, received_date, quantity, unit_cost, status, location_id, supplier_id")
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId)
        .order("expiry_date", { ascending: true, nullsFirst: false })
        .limit(50),
      sb
        .from("restaurant_stock_reservations")
        .select("id, quantity, purpose, status, location_id, needed_at, reference_type, reference_id")
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId)
        .eq("status", "active"),
      sb
        .from("restaurant_recipe_components")
        .select("id, menu_item_id, quantity, yield_percent")
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId),
      sb
        .from("restaurant_supplier_price_history")
        .select("id, supplier_id, unit_price, currency, recorded_at, stage")
        .eq("tenant_id", tenantId)
        .eq("inventory_item_id", itemId)
        .order("recorded_at", { ascending: false })
        .limit(30),
      sb
        .from("restaurant_purchase_order_items")
        .select("id, purchase_order_id, quantity, received_quantity, unit_price, description")
        .eq("inventory_item_id", itemId)
        .limit(50),
    ]);

  const locations = await locationNameMap(sb, tenantId);
  const decorate = (rows: any[] | null | undefined) =>
    ((rows ?? []) as any[]).map((r) => ({
      ...r,
      location_name: r.location_id ? (locations.get(r.location_id) ?? "Unknown") : "Unassigned",
    }));

  const moves = decorate(movements.data);
  return {
    position: positions[0] ?? null,
    movements: moves,
    consumption: moves.filter((m) => m.movement_type === "consumption"),
    waste: moves.filter((m) => m.movement_type === "wastage"),
    transfers: moves.filter((m) => m.movement_type === "transfer_in" || m.movement_type === "transfer_out"),
    receipts: moves.filter((m) => m.movement_type === "purchase_receipt"),
    stocktakes: moves.filter((m) => m.stocktake_id),
    batches: decorate(batches.data),
    reservations: decorate(reservations.data),
    recipeUsage: (recipes.data ?? []) as any[],
    supplierPricing: (supplierPrices.data ?? []) as any[],
    openOrderLines: ((openOrders.data ?? []) as any[]).filter(
      (l) => Number(l.quantity ?? 0) - Number(l.received_quantity ?? 0) > 0,
    ),
  };
}