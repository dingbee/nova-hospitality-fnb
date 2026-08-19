/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Inventory overview and ledger reconciliation.
 *
 * Reconciliation exists because a derived balance and a stored balance must be
 * provably equal. `restaurant_stock_reconciliation_v` compares the ledger sum
 * against `restaurant_inventory_items.current_quantity`; any drift is a bug or
 * a manual write, and either way staff should see it.
 */
import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { incomingIndex } from "./positions.server";
import { locationNameMap } from "./locations.server";
import type { InventoryOverview, inventoryOverviewSchema, reconciliationSchema } from "./contracts";

type Sb = any;

export async function getInventoryOverview(
  sb: Sb,
  userId: string,
  input: z.infer<typeof inventoryOverviewSchema>,
): Promise<InventoryOverview> {
  await assertTenantRead(sb, userId, input.tenantId);
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  const [items, transfers, movements, batches, locations, incoming] = await Promise.all([
    sb
      .from("restaurant_inventory_items")
      .select("id, currency, current_quantity, average_cost, reorder_point")
      .eq("tenant_id", input.tenantId)
      .eq("status", "active"),
    sb
      .from("restaurant_stock_transfers")
      .select("id, status")
      .eq("tenant_id", input.tenantId)
      .in("status", ["requested", "approved", "dispatched", "partially_received"]),
    sb
      .from("restaurant_stock_movements")
      .select("movement_type, total_cost")
      .eq("tenant_id", input.tenantId)
      .eq("movement_type", "wastage")
      .gte("occurred_at", since),
    sb
      .from("restaurant_inventory_batches")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .gt("quantity", 0)
      .lte("expiry_date", soon),
    sb.from("restaurant_locations").select("id").eq("tenant_id", input.tenantId).eq("is_storage", true),
    incomingIndex(sb, input.tenantId),
  ]);

  const rows = (items.data ?? []) as any[];
  const totalStockValue = rows.reduce(
    (s, i) => s + Number(i.current_quantity ?? 0) * Number(i.average_cost ?? 0),
    0,
  );
  const below = rows.filter(
    (i) => i.reorder_point != null && Number(i.current_quantity ?? 0) <= Number(i.reorder_point),
  );
  const critical = rows.filter((i) => Number(i.current_quantity ?? 0) <= 0);

  const { data: variances } = await sb
    .from("restaurant_stocktakes")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .gt("variance_value", 0)
    .gte("created_at", since);

  return {
    currency: rows[0]?.currency ?? "TZS",
    totalStockValue: Number(totalStockValue.toFixed(2)),
    itemsBelowReorder: below.length,
    criticalItems: critical.length,
    incomingToday: Array.from(incoming.values()).reduce((s, n) => s + n, 0),
    transfersPending: (transfers.data ?? []).length,
    stocktakeVariances: (variances ?? []).length,
    expiringSoon: (batches.data ?? []).length,
    recentWasteValue: Number(
      ((movements.data ?? []) as any[]).reduce((s, m) => s + Number(m.total_cost ?? 0), 0).toFixed(2),
    ),
    locations: (locations.data ?? []).length,
  };
}

export async function listReconciliation(
  sb: Sb,
  userId: string,
  input: z.infer<typeof reconciliationSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "reconciliation.run");
  const { data, error } = await sb
    .from("restaurant_stock_reconciliation_v")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .limit(input.limit);
  if (error) throw new Error(error.message);

  const locations = await locationNameMap(sb, input.tenantId);
  const rows = ((data ?? []) as any[]).map((r) => ({
    ...r,
    location_name: r.location_id ? (locations.get(r.location_id) ?? "Unknown") : "All locations",
    drift: Number(r.drift ?? 0),
  }));
  const drifting = rows.filter((r) => Math.abs(r.drift) > 1e-6);

  if (drifting.length > 0) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.inventory.variance.detected",
      tenantId: input.tenantId,
      entityType: "restaurant_inventory_reconciliation",
      entityId: input.tenantId,
      source: "restaurant-os",
      payload: { kind: "ledger_drift", items: drifting.length },
      dedupeKey: `reconciliation:${input.tenantId}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
  return { rows, drifting: drifting.length, clean: rows.length - drifting.length };
}