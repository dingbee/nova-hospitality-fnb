/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 3.2 — Inventory Intelligence.
 * Stock runway from consumption velocity, wastage trend, supplier price threats.
 */
import { assertTenantRead } from "../core/access.server";
import { daysOfCover, percentChange, round } from "./analysis";
import type {
  InventoryIntelligence,
  RestaurantInsight,
  StockRunwayRow,
  SupplierPriceThreat,
} from "./types";

type Sb = any;
const DAY = 864e5;
const PRICE_THREAT_PERCENT = 10;

export async function getInventoryIntelligence(
  sb: Sb,
  userId: string,
  input: { tenantId: string; windowDays: number },
): Promise<InventoryIntelligence> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId);

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();
  const weekStart = new Date(now - 7 * DAY).toISOString();
  const prevWeekStart = new Date(now - 14 * DAY).toISOString();

  const [itemsRes, movesRes, supplierProductsRes, suppliersRes] = await Promise.all([
    sb
      .from("restaurant_inventory_items")
      .select("id, name, current_quantity, reorder_point, average_cost, currency, status")
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_stock_movements")
      .select("inventory_item_id, movement_type, quantity, total_cost, occurred_at")
      .eq("tenant_id", tenantId)
      .gte("occurred_at", new Date(now - Math.max(windowDays, 14) * DAY).toISOString()),
    sb
      .from("restaurant_supplier_products")
      .select("supplier_id, inventory_item_id, name, unit_price, active")
      .eq("tenant_id", tenantId),
    sb.from("restaurant_suppliers").select("id, name").eq("tenant_id", tenantId),
  ]);

  const items = (itemsRes.data ?? []) as any[];
  const moves = (movesRes.data ?? []) as any[];
  const currency = (items[0]?.currency as string) ?? "TZS";

  const consumption = new Map<string, number>();
  for (const m of moves) {
    if (m.occurred_at < start) continue;
    if (m.movement_type !== "consumption" && m.movement_type !== "wastage") continue;
    consumption.set(
      m.inventory_item_id,
      (consumption.get(m.inventory_item_id) ?? 0) + Math.abs(Number(m.quantity ?? 0)),
    );
  }

  const runway: StockRunwayRow[] = items.map((it) => {
    const velocity = round((consumption.get(it.id) ?? 0) / windowDays, 3);
    const qty = Number(it.current_quantity ?? 0);
    return {
      inventoryItemId: it.id,
      name: it.name,
      currentQuantity: round(qty, 2),
      dailyVelocity: velocity,
      daysOfCover: daysOfCover(qty, velocity),
      reorderPoint: it.reorder_point == null ? null : Number(it.reorder_point),
      belowReorder: it.reorder_point != null && qty <= Number(it.reorder_point),
    };
  });
  runway.sort((a, b) => (a.daysOfCover ?? 9999) - (b.daysOfCover ?? 9999));

  const atRisk = runway.filter((r) => (r.daysOfCover != null && r.daysOfCover <= 5) || r.belowReorder).slice(0, 12);

  const wasteRows = moves.filter((m) => m.movement_type === "wastage");
  const currentWaste = wasteRows
    .filter((m) => m.occurred_at >= weekStart)
    .reduce((s, m) => s + Math.abs(Number(m.total_cost ?? 0)), 0);
  const previousWaste = wasteRows
    .filter((m) => m.occurred_at >= prevWeekStart && m.occurred_at < weekStart)
    .reduce((s, m) => s + Math.abs(Number(m.total_cost ?? 0)), 0);

  const nameById = new Map(items.map((i) => [i.id, i.name as string]));
  const wasteByItem = new Map<string, { cost: number; quantity: number }>();
  for (const m of wasteRows.filter((w) => w.occurred_at >= weekStart)) {
    const cur = wasteByItem.get(m.inventory_item_id) ?? { cost: 0, quantity: 0 };
    cur.cost += Math.abs(Number(m.total_cost ?? 0));
    cur.quantity += Math.abs(Number(m.quantity ?? 0));
    wasteByItem.set(m.inventory_item_id, cur);
  }
  const topWaste = [...wasteByItem.entries()]
    .map(([id, v]) => ({ name: nameById.get(id) ?? "Item", cost: round(v.cost), quantity: round(v.quantity, 2) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  const supplierNames = new Map(((suppliersRes.data ?? []) as any[]).map((s) => [s.id, s.name as string]));
  const avgCost = new Map(items.map((i) => [i.id, Number(i.average_cost ?? 0)]));
  const priceThreats: SupplierPriceThreat[] = ((supplierProductsRes.data ?? []) as any[])
    .filter((p) => p.active !== false && p.inventory_item_id)
    .map((p) => {
      const base = avgCost.get(p.inventory_item_id) ?? 0;
      const price = Number(p.unit_price ?? 0);
      const increase = base > 0 ? round(((price - base) / base) * 100, 1) : 0;
      return {
        supplierName: supplierNames.get(p.supplier_id) ?? "Supplier",
        itemName: nameById.get(p.inventory_item_id) ?? p.name ?? "Item",
        supplierPrice: round(price),
        averageCost: round(base),
        increasePercent: increase,
      };
    })
    .filter((t) => t.increasePercent >= PRICE_THREAT_PERCENT)
    .sort((a, b) => b.increasePercent - a.increasePercent)
    .slice(0, 8);

  const insights: RestaurantInsight[] = [];
  for (const r of atRisk.slice(0, 4)) {
    insights.push({
      key: `inventory.runway.${r.inventoryItemId}`,
      severity: (r.daysOfCover ?? 99) <= 2 ? "critical" : (r.daysOfCover ?? 99) <= 4 ? "high" : "medium",
      title:
        r.daysOfCover == null
          ? `${r.name} is below its reorder point`
          : `${r.name} will likely run out in ${r.daysOfCover} days`,
      detail: `On hand ${r.currentQuantity} · consumption ${r.dailyVelocity}/day over the last ${windowDays} days.`,
      metric: r.daysOfCover == null ? "below reorder point" : `${r.daysOfCover} days of cover`,
      recommendation: "Raise a purchase order now so delivery lands before stock-out.",
    });
  }
  const wasteChange = percentChange(currentWaste, previousWaste);
  if (wasteChange != null && Math.abs(wasteChange) >= 10) {
    insights.push({
      key: "inventory.waste_trend",
      severity: wasteChange > 25 ? "high" : wasteChange > 0 ? "medium" : "info",
      title: `Waste ${wasteChange > 0 ? "increased" : "decreased"} ${Math.abs(wasteChange)}% this week`,
      detail: `${currency} ${round(currentWaste).toLocaleString()} wasted this week versus ${currency} ${round(previousWaste).toLocaleString()} last week.`,
      metric: `${wasteChange > 0 ? "+" : ""}${wasteChange}%`,
      recommendation:
        wasteChange > 0
          ? "Review prep par levels and rotation on the top wasted items."
          : "Capture what changed so the improvement holds.",
    });
  }
  for (const t of priceThreats.slice(0, 3)) {
    insights.push({
      key: `inventory.price_threat.${t.supplierName}.${t.itemName}`,
      severity: t.increasePercent >= 25 ? "high" : "medium",
      title: `Supplier price change threatens margin on ${t.itemName}`,
      detail: `${t.supplierName} quotes ${currency} ${t.supplierPrice.toLocaleString()} against an average cost of ${currency} ${t.averageCost.toLocaleString()}.`,
      metric: `+${t.increasePercent}%`,
      recommendation: "Re-quote, switch supplier, or reprice the dishes that use this ingredient.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency,
    runway: runway.slice(0, 40),
    atRisk,
    wastage: {
      currentCost: round(currentWaste),
      previousCost: round(previousWaste),
      changePercent: wasteChange,
      topItems: topWaste,
    },
    priceThreats,
    insights,
  };
}