/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P05 §7 — Demand Intelligence (Pro).
 *
 * Reads the same authoritative order/order-item tables profitability.server.ts
 * and menu.server.ts already read (restaurant_orders, restaurant_order_items,
 * restaurant_service_periods) and reasons over sales volume by day-of-week,
 * service period and item — nothing here recomputes revenue or cost; it is a
 * pure volume/pattern lens on data those engines already treat as
 * authoritative.
 *
 * A finalized order is one in status "closed" — the same finality bar
 * profitability.server.ts uses. Cancelled/voided/still-open orders are
 * excluded because they never represented a completed guest transaction.
 */
import { assertTenantRead } from "../core/access.server";
import { round, percentChange } from "./analysis";
import { assessDataSufficiency } from "./sufficiency";
import type { RestaurantInsight } from "./types";
import type {
  DayOfWeekDemand,
  DemandIntelligence,
  ItemDemandRow,
  P05WindowInput,
  ServicePeriodDemand,
} from "./p05.types";

type Sb = any;
const DAY = 864e5;
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function getDemandIntelligence(
  sb: Sb,
  userId: string,
  input: P05WindowInput,
): Promise<DemandIntelligence> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
  const { assertEntitled } = await import("@/modules/commercial/resolver.server");
  await assertEntitled(sb, tenantId, "demand_intelligence", {
    propertyId: input.propertyId ?? null,
  });

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();
  const prevStart = new Date(now - windowDays * 2 * DAY).toISOString();

  let ordersQuery = sb
    .from("restaurant_orders")
    .select("id, service_period_id, guest_count, opened_at, currency, status")
    .eq("tenant_id", tenantId)
    .eq("status", "closed")
    .gte("opened_at", prevStart);
  if (input.propertyId) ordersQuery = ordersQuery.eq("property_id", input.propertyId);
  if (input.locationId) ordersQuery = ordersQuery.eq("location_id", input.locationId);

  const [ordersRes, periodsRes] = await Promise.all([
    ordersQuery,
    sb.from("restaurant_service_periods").select("id, name").eq("tenant_id", tenantId),
  ]);

  const orders = (ordersRes.data ?? []) as any[];
  const currentOrders = orders.filter((o) => o.opened_at >= start);
  const previousOrders = orders.filter((o) => o.opened_at >= prevStart && o.opened_at < start);
  const currency = (currentOrders[0] ?? orders[0])?.currency ?? "TZS";
  const periodNames = new Map(
    ((periodsRes.data ?? []) as any[]).map((p) => [p.id, p.name as string]),
  );

  const orderIds = currentOrders.map((o) => o.id);
  let items: any[] = [];
  let prevItems: any[] = [];
  if (orderIds.length > 0 || previousOrders.length > 0) {
    const allIds = [...orderIds, ...previousOrders.map((o) => o.id)];
    const { data: itemRows } = await sb
      .from("restaurant_order_items")
      .select("order_id, menu_item_id, description, quantity, status")
      .eq("tenant_id", tenantId)
      .in("order_id", allIds.length ? allIds : ["00000000-0000-0000-0000-000000000000"]);
    const rows = ((itemRows ?? []) as any[]).filter((r) => r.status !== "voided");
    const currentIdSet = new Set(orderIds);
    items = rows.filter((r) => currentIdSet.has(r.order_id));
    prevItems = rows.filter((r) => !currentIdSet.has(r.order_id));
  }

  // Distinct calendar days with at least one closed order — the sample this
  // domain's sufficiency band is judged on (not raw order count alone, so a
  // single very busy day is never mistaken for a stable weekly pattern).
  const distinctDays = new Set(currentOrders.map((o) => String(o.opened_at).slice(0, 10))).size;
  const sufficiency = assessDataSufficiency(currentOrders.length, distinctDays);

  // By day of week: average orders per occurrence of that weekday within the window.
  const dowOccurrences = new Array(7).fill(0);
  {
    const startD = new Date(start);
    const endD = new Date(now);
    for (let d = new Date(startD); d < endD; d.setUTCDate(d.getUTCDate() + 1)) {
      dowOccurrences[d.getUTCDay()] += 1;
    }
  }
  const dowOrders = new Array(7).fill(0);
  const dowCovers = new Array(7).fill(0);
  for (const o of currentOrders) {
    const dow = new Date(o.opened_at).getUTCDay();
    dowOrders[dow] += 1;
    dowCovers[dow] += Number(o.guest_count ?? 0);
  }
  const byDayOfWeek: DayOfWeekDemand[] = DAY_LABELS.map((label, dow) => ({
    dayOfWeek: dow,
    label,
    orders: dowOrders[dow],
    averageOrdersPerOccurrence:
      dowOccurrences[dow] > 0 ? round(dowOrders[dow] / dowOccurrences[dow], 2) : 0,
    covers: dowCovers[dow],
  }));

  // By service period.
  const periodAgg = new Map<string, { orders: number; covers: number }>();
  for (const o of currentOrders) {
    const key = o.service_period_id ?? "unassigned";
    const cur = periodAgg.get(key) ?? { orders: 0, covers: 0 };
    cur.orders += 1;
    cur.covers += Number(o.guest_count ?? 0);
    periodAgg.set(key, cur);
  }
  const byServicePeriod: ServicePeriodDemand[] = [...periodAgg.entries()]
    .map(([id, v]) => ({
      servicePeriodId: id === "unassigned" ? null : id,
      name: id === "unassigned" ? "Unassigned" : (periodNames.get(id) ?? "Service period"),
      orders: v.orders,
      covers: v.covers,
      revenue: 0,
    }))
    .sort((a, b) => b.orders - a.orders);

  // Item demand: current vs previous window, quantity-based (no revenue —
  // that's revenue.server.ts's job).
  const currentQty = new Map<string, { name: string; qty: number }>();
  for (const it of items) {
    const key = it.menu_item_id ?? `adhoc:${it.description}`;
    const cur = currentQty.get(key) ?? { name: it.description, qty: 0 };
    cur.qty += Number(it.quantity ?? 0);
    currentQty.set(key, cur);
  }
  const previousQty = new Map<string, number>();
  for (const it of prevItems) {
    const key = it.menu_item_id ?? `adhoc:${it.description}`;
    previousQty.set(key, (previousQty.get(key) ?? 0) + Number(it.quantity ?? 0));
  }

  const itemRows: ItemDemandRow[] = [...currentQty.entries()].map(([key, v]) => {
    const prevQty = round(previousQty.get(key) ?? 0, 2);
    const trendPercent = percentChange(v.qty, prevQty);
    const trend: ItemDemandRow["trend"] =
      trendPercent == null
        ? "stable"
        : trendPercent >= 20
          ? "emerging"
          : trendPercent <= -20
            ? "declining"
            : "stable";
    return {
      menuItemId: key.startsWith("adhoc:") ? "" : key,
      name: v.name,
      quantitySold: round(v.qty, 2),
      previousQuantitySold: prevQty,
      trendPercent,
      trend,
    };
  });
  itemRows.sort((a, b) => b.quantitySold - a.quantitySold);
  const topItems = itemRows.slice(0, 15);
  const emergingItems = itemRows
    .filter((i) => i.trend === "emerging" && i.quantitySold >= 3)
    .sort((a, b) => (b.trendPercent ?? 0) - (a.trendPercent ?? 0))
    .slice(0, 8);
  const decliningItems = itemRows
    .filter((i) => i.trend === "declining" && i.previousQuantitySold >= 3)
    .sort((a, b) => (a.trendPercent ?? 0) - (b.trendPercent ?? 0))
    .slice(0, 8);

  const orderTrendPercent = percentChange(currentOrders.length, previousOrders.length);

  const insights: RestaurantInsight[] = [];
  if (sufficiency.state === "NO_DATA" || sufficiency.state === "INSUFFICIENT_DATA") {
    insights.push({
      key: "demand.insufficient_data",
      severity: "info",
      title: "Not enough order history to identify demand patterns yet",
      detail: sufficiency.reasons.join(" "),
      metric: `${currentOrders.length} closed orders over ${distinctDays} day(s)`,
    });
  } else {
    const busiest = [...byDayOfWeek].sort(
      (a, b) => b.averageOrdersPerOccurrence - a.averageOrdersPerOccurrence,
    )[0];
    if (busiest && busiest.averageOrdersPerOccurrence > 0) {
      insights.push({
        key: "demand.busiest_day",
        severity: "info",
        title: `${busiest.label} is this location's busiest day`,
        detail: `Averaging ${busiest.averageOrdersPerOccurrence} orders per ${busiest.label} over the last ${windowDays} days.`,
        metric: `${busiest.averageOrdersPerOccurrence} orders/day`,
      });
    }
    if (orderTrendPercent != null && Math.abs(orderTrendPercent) >= 15) {
      insights.push({
        key: "demand.order_trend",
        severity: orderTrendPercent < -15 ? "high" : "medium",
        title: `Order volume ${orderTrendPercent > 0 ? "grew" : "fell"} ${Math.abs(orderTrendPercent)}% vs the prior ${windowDays} days`,
        detail: `${currentOrders.length} closed orders this window versus ${previousOrders.length} the window before.`,
        metric: `${orderTrendPercent > 0 ? "+" : ""}${orderTrendPercent}%`,
        recommendation:
          orderTrendPercent > 0
            ? "Review staffing and prep par levels to keep pace with rising demand."
            : "Investigate what changed — marketing, seasonality, competition, or an operational issue.",
      });
    }
    for (const e of emergingItems.slice(0, 2)) {
      insights.push({
        key: `demand.emerging.${e.menuItemId || e.name}`,
        severity: "medium",
        title: `${e.name} demand is emerging`,
        detail: `${e.quantitySold} sold this window vs ${e.previousQuantitySold} the window before.`,
        metric: `${e.trendPercent != null && e.trendPercent > 0 ? "+" : ""}${e.trendPercent}%`,
        recommendation: "Confirm stock and prep capacity can sustain the increase.",
      });
    }
    for (const d of decliningItems.slice(0, 2)) {
      insights.push({
        key: `demand.declining.${d.menuItemId || d.name}`,
        severity: "low",
        title: `${d.name} demand is declining`,
        detail: `${d.quantitySold} sold this window vs ${d.previousQuantitySold} the window before.`,
        metric: `${d.trendPercent}%`,
        recommendation: "Review pricing, positioning, or whether this item should be retired.",
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency,
    sufficiency: sufficiency.state,
    sufficiencyReasons: sufficiency.reasons,
    totalOrders: currentOrders.length,
    totalCovers: dowCovers.reduce((a, b) => a + b, 0),
    previousTotalOrders: previousOrders.length,
    orderTrendPercent,
    byDayOfWeek,
    byServicePeriod,
    topItems,
    emergingItems,
    decliningItems,
    insights,
  };
}
