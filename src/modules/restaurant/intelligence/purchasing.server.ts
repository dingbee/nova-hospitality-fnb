/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 3.4 — Purchasing Intelligence.
 * Forecast-driven purchase quantities, supplier reliability ranking, and the
 * expected cost impact of next month's consumption.
 */
import { assertTenantRead } from "../core/access.server";
import { percentChange, recommendedPurchaseQuantity, reliabilityScore, round } from "./analysis";
import type {
  PurchaseSuggestion,
  PurchasingIntelligence,
  RestaurantInsight,
  SupplierReliability,
} from "./types";

type Sb = any;
const DAY = 864e5;
const COVER_DAYS = 7;
const DEFAULT_LEAD_TIME = 3;

export async function getPurchasingIntelligence(
  sb: Sb,
  userId: string,
  input: { tenantId: string; windowDays: number },
): Promise<PurchasingIntelligence> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId);

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();
  const monthStart = new Date(now - 30 * DAY).toISOString();
  const prevMonthStart = new Date(now - 60 * DAY).toISOString();

  const [itemsRes, movesRes, productsRes, suppliersRes, poRes] = await Promise.all([
    sb
      .from("restaurant_inventory_items")
      .select("id, name, current_quantity, average_cost, currency")
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_stock_movements")
      .select("inventory_item_id, movement_type, quantity, total_cost, occurred_at")
      .eq("tenant_id", tenantId)
      .gte("occurred_at", prevMonthStart),
    sb
      .from("restaurant_supplier_products")
      .select("supplier_id, inventory_item_id, unit_price, lead_time_days, active")
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_suppliers")
      .select("id, name, lead_time_days, reliability_score, status")
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_purchase_orders")
      .select("id, supplier_id, status, order_date, expected_at, received_at, total")
      .eq("tenant_id", tenantId),
  ]);

  const items = (itemsRes.data ?? []) as any[];
  const moves = (movesRes.data ?? []) as any[];
  const currency = (items[0]?.currency as string) ?? "TZS";
  const suppliers = (suppliersRes.data ?? []) as any[];
  const products = ((productsRes.data ?? []) as any[]).filter((p) => p.active !== false);

  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const bestProduct = new Map<string, any>();
  for (const p of products) {
    if (!p.inventory_item_id) continue;
    const prev = bestProduct.get(p.inventory_item_id);
    if (!prev || Number(p.unit_price ?? 0) < Number(prev.unit_price ?? 0)) {
      bestProduct.set(p.inventory_item_id, p);
    }
  }

  const consumed = new Map<string, number>();
  for (const m of moves) {
    if (m.occurred_at < start) continue;
    if (m.movement_type !== "consumption" && m.movement_type !== "wastage") continue;
    consumed.set(
      m.inventory_item_id,
      (consumed.get(m.inventory_item_id) ?? 0) + Math.abs(Number(m.quantity ?? 0)),
    );
  }

  const suggestions: PurchaseSuggestion[] = [];
  let expectedMonthlySpend = 0;
  for (const it of items) {
    const velocity = round((consumed.get(it.id) ?? 0) / windowDays, 3);
    if (velocity <= 0) continue;
    const product = bestProduct.get(it.id);
    const supplier = product ? supplierById.get(product.supplier_id) : null;
    const leadTime =
      Number(product?.lead_time_days ?? supplier?.lead_time_days ?? DEFAULT_LEAD_TIME) || DEFAULT_LEAD_TIME;
    const unitPrice = Number(product?.unit_price ?? it.average_cost ?? 0);
    const qty = recommendedPurchaseQuantity(Number(it.current_quantity ?? 0), velocity, leadTime, COVER_DAYS);
    expectedMonthlySpend += velocity * 30 * unitPrice;
    if (qty <= 0) continue;
    suggestions.push({
      inventoryItemId: it.id,
      name: it.name,
      currentQuantity: round(Number(it.current_quantity ?? 0), 2),
      dailyVelocity: velocity,
      leadTimeDays: leadTime,
      coverDays: COVER_DAYS,
      recommendedQuantity: qty,
      estimatedCost: round(qty * unitPrice),
      supplierName: supplier?.name ?? null,
      supplierId: supplier?.id ?? null,
    });
  }
  suggestions.sort((a, b) => b.estimatedCost - a.estimatedCost);

  const orders = (poRes.data ?? []) as any[];
  const ranking: SupplierReliability[] = suppliers.map((s) => {
    const own = orders.filter((o) => o.supplier_id === s.id && o.received_at);
    const onTime = own.filter((o) => !o.expected_at || o.received_at.slice(0, 10) <= o.expected_at).length;
    const leadTimes = own
      .filter((o) => o.order_date)
      .map((o) => (new Date(o.received_at).getTime() - new Date(o.order_date).getTime()) / DAY);
    const averageLead =
      leadTimes.length > 0 ? round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length, 1) : null;
    const onTimePercent = own.length > 0 ? round((onTime / own.length) * 100, 1) : null;
    const declared = s.lead_time_days == null ? null : Number(s.lead_time_days);
    return {
      supplierId: s.id,
      name: s.name,
      orders: own.length,
      onTime,
      onTimePercent,
      averageLeadTimeDays: averageLead,
      declaredLeadTimeDays: declared,
      score: reliabilityScore(onTimePercent, averageLead, declared),
    };
  });
  ranking.sort((a, b) => b.score - a.score);

  const spendCost = (from: string, to?: string) =>
    moves
      .filter(
        (m) =>
          (m.movement_type === "consumption" || m.movement_type === "wastage") &&
          m.occurred_at >= from &&
          (to ? m.occurred_at < to : true),
      )
      .reduce((s, m) => s + Math.abs(Number(m.total_cost ?? 0)), 0);
  const previousMonthlySpend = spendCost(prevMonthStart, monthStart);
  const spendChange = percentChange(expectedMonthlySpend, previousMonthlySpend);

  const insights: RestaurantInsight[] = [];
  if (suggestions.length > 0) {
    const top = suggestions.slice(0, 3);
    insights.push({
      key: "purchasing.suggestions",
      severity: "medium",
      title: `${suggestions.length} items should be ordered to cover forecast demand`,
      detail: top
        .map(
          (s) =>
            `${s.name} — ${s.recommendedQuantity} units (${s.dailyVelocity}/day, ${s.leadTimeDays}d lead time)`,
        )
        .join("; "),
      metric: `${currency} ${round(top.reduce((a, s) => a + s.estimatedCost, 0)).toLocaleString()} top-3 cost`,
      recommendation: "Raise purchase orders covering lead time plus a 7-day safety window.",
    });
  }
  const best = ranking.find((r) => r.orders > 0);
  const worst = [...ranking].reverse().find((r) => r.orders > 0);
  if (best && worst && best.supplierId !== worst.supplierId) {
    insights.push({
      key: "purchasing.reliability",
      severity: worst.score < 60 ? "high" : "info",
      title: `${best.name} is your most reliable supplier`,
      detail: `${best.name} scores ${best.score}/100 (${best.onTimePercent ?? 0}% on time) while ${worst.name} scores ${worst.score}/100 (${worst.onTimePercent ?? 0}% on time).`,
      metric: `${best.score} vs ${worst.score}`,
      recommendation: "Shift critical, short-shelf-life lines to the higher-scoring supplier.",
    });
  }
  if (spendChange != null) {
    insights.push({
      key: "purchasing.cost_impact",
      severity: spendChange > 15 ? "high" : spendChange > 0 ? "medium" : "info",
      title: `Expected cost impact next month: ${currency} ${round(expectedMonthlySpend).toLocaleString()}`,
      detail: `Projected from current consumption velocity and best supplier prices, versus ${currency} ${round(previousMonthlySpend).toLocaleString()} consumed last month.`,
      metric: `${spendChange > 0 ? "+" : ""}${spendChange}%`,
      recommendation:
        spendChange > 0
          ? "Re-negotiate the fastest-moving lines before the increase lands."
          : "Hold current supplier terms — projected spend is trending down.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency,
    suggestions: suggestions.slice(0, 25),
    suppliers: ranking,
    expectedMonthlySpend: round(expectedMonthlySpend),
    previousMonthlySpend: round(previousMonthlySpend),
    spendChangePercent: spendChange,
    insights,
  };
}