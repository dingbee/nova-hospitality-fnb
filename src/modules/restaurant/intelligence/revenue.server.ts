/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P05 §9 — Revenue Intelligence (Pro).
 *
 * Revenue itself is read straight from restaurant_orders/restaurant_order_items
 * — the same authoritative sales-of-record profitability.server.ts and
 * menu.server.ts already read. Margin/profitability is NEVER computed here:
 * it is read, unmodified, from restaurant_profitability_snapshots — the one
 * authoritative writer of cost-vs-revenue (costing/profitability.server.ts).
 * An item with no snapshot in this window gets `marginPercent: null` and
 * `marginSource: "unavailable"` rather than an estimated figure — the
 * master prompt's "distinguish REVENUE from PROFIT/MARGIN" and "do not
 * claim profitability unless cost data is sufficiently authoritative" rules
 * applied literally.
 *
 * "Closed" orders are the same finality bar demand.server.ts and
 * profitability.server.ts use. Refunded orders are excluded from revenue
 * totals (money that came back out never represents realized revenue) but a
 * comped order's original total still counts — comping is a pricing
 * decision, not an absence of a transaction.
 */
import { assertTenantRead } from "../core/access.server";
import { round, percentChange } from "./analysis";
import { assessDataSufficiency } from "./sufficiency";
import type { RestaurantInsight } from "./types";
import type {
  OutletRevenuePerformance,
  P05WindowInput,
  RevenueIntelligence,
  RevenueItemContribution,
  RevenuePeriodPoint,
  SalesComposition,
  ServicePeriodDemand,
} from "./p05.types";

type Sb = any;
const DAY = 864e5;

export async function getRevenueIntelligence(
  sb: Sb,
  userId: string,
  input: P05WindowInput,
): Promise<RevenueIntelligence> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
  const { assertEntitled } = await import("@/modules/commercial/resolver.server");
  await assertEntitled(sb, tenantId, "revenue_intelligence", {
    propertyId: input.propertyId ?? null,
  });

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();
  const prevStart = new Date(now - windowDays * 2 * DAY).toISOString();

  let ordersQuery = sb
    .from("restaurant_orders")
    .select(
      "id, location_id, service_period_id, opened_at, subtotal, discount_total, tax_total, service_charge, total, paid_total, payment_state, currency, status",
    )
    .eq("tenant_id", tenantId)
    .eq("status", "closed")
    .neq("payment_state", "refunded")
    .gte("opened_at", prevStart);
  if (input.propertyId) ordersQuery = ordersQuery.eq("property_id", input.propertyId);
  if (input.locationId) ordersQuery = ordersQuery.eq("location_id", input.locationId);

  const [ordersRes, locationsRes, periodsRes] = await Promise.all([
    ordersQuery,
    sb.from("restaurant_locations").select("id, name").eq("tenant_id", tenantId),
    sb.from("restaurant_service_periods").select("id, name").eq("tenant_id", tenantId),
  ]);

  const allOrders = (ordersRes.data ?? []) as any[];
  const currentOrders = allOrders.filter((o) => o.opened_at >= start);
  const previousOrders = allOrders.filter((o) => o.opened_at >= prevStart && o.opened_at < start);
  const currency = (currentOrders[0] ?? allOrders[0])?.currency ?? "TZS";
  const locationNames = new Map(
    ((locationsRes.data ?? []) as any[]).map((l) => [l.id, l.name as string]),
  );
  const periodNames = new Map(
    ((periodsRes.data ?? []) as any[]).map((p) => [p.id, p.name as string]),
  );

  const distinctDays = new Set(currentOrders.map((o) => String(o.opened_at).slice(0, 10))).size;
  const sufficiency = assessDataSufficiency(currentOrders.length, distinctDays);

  const totalRevenue = round(currentOrders.reduce((s, o) => s + Number(o.total ?? 0), 0));
  const previousRevenue = round(previousOrders.reduce((s, o) => s + Number(o.total ?? 0), 0));
  const revenueTrendPercent = percentChange(totalRevenue, previousRevenue);
  const averageOrderValue =
    currentOrders.length > 0 ? round(totalRevenue / currentOrders.length) : 0;

  // P07 §5 — Sales ≠ Revenue ≠ Cash Collection, made explicit. Every figure
  // here is a straight sum of restaurant_orders' own decomposition columns
  // for the exact same closed/non-refunded current-window order set
  // totalRevenue is computed from — never a second derivation.
  const grossSales = round(currentOrders.reduce((s, o) => s + Number(o.subtotal ?? 0), 0));
  const discountTotal = round(currentOrders.reduce((s, o) => s + Number(o.discount_total ?? 0), 0));
  const taxTotal = round(currentOrders.reduce((s, o) => s + Number(o.tax_total ?? 0), 0));
  const serviceChargeTotal = round(
    currentOrders.reduce((s, o) => s + Number(o.service_charge ?? 0), 0),
  );
  const cashCollected = round(currentOrders.reduce((s, o) => s + Number(o.paid_total ?? 0), 0));
  const salesComposition: SalesComposition = {
    grossSales,
    discountTotal,
    taxTotal,
    serviceChargeTotal,
    netSales: totalRevenue,
    cashCollected,
    outstandingAmount: round(totalRevenue - cashCollected),
  };

  // Daily revenue series for the current window.
  const dailyMap = new Map<string, { revenue: number; orders: number }>();
  for (const o of currentOrders) {
    const day = String(o.opened_at).slice(0, 10);
    const cur = dailyMap.get(day) ?? { revenue: 0, orders: 0 };
    cur.revenue += Number(o.total ?? 0);
    cur.orders += 1;
    dailyMap.set(day, cur);
  }
  const series: RevenuePeriodPoint[] = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, revenue: round(v.revenue), orders: v.orders }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // By service period.
  const periodAgg = new Map<string, { orders: number; revenue: number }>();
  for (const o of currentOrders) {
    const key = o.service_period_id ?? "unassigned";
    const cur = periodAgg.get(key) ?? { orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += Number(o.total ?? 0);
    periodAgg.set(key, cur);
  }
  const byServicePeriod: ServicePeriodDemand[] = [...periodAgg.entries()]
    .map(([id, v]) => ({
      servicePeriodId: id === "unassigned" ? null : id,
      name: id === "unassigned" ? "Unassigned" : (periodNames.get(id) ?? "Service period"),
      orders: v.orders,
      covers: 0,
      revenue: round(v.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // By outlet (location).
  const locAgg = new Map<string, { orders: number; revenue: number }>();
  for (const o of currentOrders) {
    if (!o.location_id) continue;
    const cur = locAgg.get(o.location_id) ?? { orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += Number(o.total ?? 0);
    locAgg.set(o.location_id, cur);
  }
  const byOutlet: OutletRevenuePerformance[] = [...locAgg.entries()]
    .map(([id, v]) => ({
      locationId: id,
      name: locationNames.get(id) ?? "Location",
      revenue: round(v.revenue),
      orders: v.orders,
      averageOrderValue: v.orders > 0 ? round(v.revenue / v.orders) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // Item contribution: revenue from order items in the window, plus margin
  // read (never computed) from the authoritative profitability snapshots
  // table when one exists covering this window.
  const orderIds = currentOrders.map((o) => o.id);
  let itemRows: any[] = [];
  let snapshotRows: any[] = [];
  if (orderIds.length > 0) {
    const [{ data: items }, { data: snapshots }] = await Promise.all([
      sb
        .from("restaurant_order_items")
        .select("order_id, menu_item_id, description, quantity, line_total, status")
        .eq("tenant_id", tenantId)
        .in("order_id", orderIds),
      sb
        .from("restaurant_profitability_snapshots")
        .select("menu_item_id, margin_percent, period_start, period_end")
        .eq("tenant_id", tenantId)
        .gte("period_end", start.slice(0, 10)),
    ]);
    itemRows = ((items ?? []) as any[]).filter((r) => r.status !== "voided");
    snapshotRows = (snapshots ?? []) as any[];
  }
  const marginByItem = new Map<string, number>();
  for (const s of snapshotRows) {
    if (s.menu_item_id && s.margin_percent != null && !marginByItem.has(s.menu_item_id)) {
      marginByItem.set(s.menu_item_id, Number(s.margin_percent));
    }
  }

  const itemAgg = new Map<string, { name: string; revenue: number; qty: number }>();
  for (const it of itemRows) {
    const key = it.menu_item_id ?? `adhoc:${it.description}`;
    const cur = itemAgg.get(key) ?? { name: it.description, revenue: 0, qty: 0 };
    cur.revenue += Number(it.line_total ?? 0);
    cur.qty += Number(it.quantity ?? 0);
    itemAgg.set(key, cur);
  }
  const itemRevenueTotal = [...itemAgg.values()].reduce((s, v) => s + v.revenue, 0);
  const contributions: RevenueItemContribution[] = [...itemAgg.entries()]
    .map(([key, v]) => {
      const menuItemId = key.startsWith("adhoc:") ? null : key;
      const margin = menuItemId ? marginByItem.get(menuItemId) : undefined;
      return {
        menuItemId: menuItemId ?? "",
        name: v.name,
        revenue: round(v.revenue),
        quantitySold: round(v.qty, 2),
        revenueSharePercent:
          itemRevenueTotal > 0 ? round((v.revenue / itemRevenueTotal) * 100, 1) : 0,
        marginPercent: margin ?? null,
        marginSource: (margin != null ? "profitability_snapshot" : "unavailable") as
          "profitability_snapshot" | "unavailable",
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
  const topContributors = contributions.slice(0, 10);
  const underperformers = [...contributions].reverse().slice(0, 10);
  const marginDataAvailable = marginByItem.size > 0;

  const anomalies: RestaurantInsight[] = [];
  const insights: RestaurantInsight[] = [];

  if (sufficiency.state === "NO_DATA" || sufficiency.state === "INSUFFICIENT_DATA") {
    insights.push({
      key: "revenue.insufficient_data",
      severity: "info",
      title: "Not enough closed-order history to report revenue trends yet",
      detail: sufficiency.reasons.join(" "),
      metric: `${currentOrders.length} closed orders over ${distinctDays} day(s)`,
    });
  } else {
    if (revenueTrendPercent != null && Math.abs(revenueTrendPercent) >= 10) {
      const insight: RestaurantInsight = {
        key: "revenue.trend",
        severity: revenueTrendPercent < -20 ? "high" : revenueTrendPercent < 0 ? "medium" : "info",
        title: `Revenue ${revenueTrendPercent > 0 ? "grew" : "fell"} ${Math.abs(revenueTrendPercent)}% vs the prior ${windowDays} days`,
        detail: `${currency} ${totalRevenue.toLocaleString()} this window versus ${currency} ${previousRevenue.toLocaleString()} the window before.`,
        metric: `${revenueTrendPercent > 0 ? "+" : ""}${revenueTrendPercent}%`,
      };
      insights.push(insight);
      if (revenueTrendPercent <= -20) anomalies.push(insight);
    }
    if (byOutlet.length >= 2) {
      const avg = byOutlet.reduce((s, o) => s + o.revenue, 0) / byOutlet.length;
      const worst = [...byOutlet].sort((a, b) => a.revenue - b.revenue)[0];
      if (worst && avg > 0 && worst.revenue < avg * 0.5) {
        const insight: RestaurantInsight = {
          key: `revenue.outlet_underperformance.${worst.locationId}`,
          severity: "medium",
          title: `${worst.name} is materially underperforming the group average`,
          detail: `${currency} ${worst.revenue.toLocaleString()} versus a group average of ${currency} ${round(avg).toLocaleString()}.`,
          metric: `${round(((worst.revenue - avg) / avg) * 100, 1)}%`,
          recommendation: "Investigate staffing, footfall, or menu fit at this outlet.",
        };
        insights.push(insight);
        anomalies.push(insight);
      }
    }
    if (!marginDataAvailable) {
      insights.push({
        key: "revenue.margin_unavailable",
        severity: "info",
        title: "Margin data is not available for this window",
        detail:
          "No profitability snapshots have been computed for this period yet — revenue figures above do not imply profitability.",
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency,
    sufficiency: sufficiency.state,
    sufficiencyReasons: sufficiency.reasons,
    totalRevenue,
    previousRevenue,
    revenueTrendPercent,
    totalOrders: currentOrders.length,
    averageOrderValue,
    salesComposition,
    series,
    byServicePeriod,
    topContributors,
    underperformers,
    byOutlet,
    marginDataAvailable,
    anomalies,
    insights,
  };
}
