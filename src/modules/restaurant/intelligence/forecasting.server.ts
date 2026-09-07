/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P05 §8 — Forecasting (Pro).
 *
 * Composes three forecasts through the ONE shared deterministic engine in
 * forecast.ts (see that file's doc comment for why there is only one):
 *
 *  - Sales demand forecast: daily closed-order-count series -> trend.
 *  - Revenue forecast: daily closed-order-revenue series -> trend.
 *  - Inventory requirement forecast: NOT recomputed here — it reads
 *    purchasing.server.ts's existing `getPurchasingIntelligence` suggestions
 *    verbatim (velocity-projected recommended quantities) and reframes them
 *    under a forecasting lens with an explicit horizon/limitations block,
 *    rather than building a second inventory-requirement projection.
 *
 * Deliberately queries restaurant_orders directly for its own two series
 * rather than calling getDemandIntelligence/getRevenueIntelligence — those
 * are gated on their own "demand_intelligence"/"revenue_intelligence"
 * capabilities, and a tenant entitled to "forecasting" alone must not be
 * denied because it isn't entitled to a sibling capability.
 */
import { assertTenantRead } from "../core/access.server";
import { round } from "./analysis";
import { fillDailySeries, forecastFromDailySeries } from "./forecast";
import { getPurchasingIntelligence } from "./purchasing.server";
import { assessDataSufficiency } from "./sufficiency";
import type { RestaurantInsight } from "./types";
import type { ForecastingIntelligence, P05ForecastWindowInput } from "./p05.types";

type Sb = any;
const DAY = 864e5;

export async function getForecastingIntelligence(
  sb: Sb,
  userId: string,
  input: P05ForecastWindowInput,
): Promise<ForecastingIntelligence> {
  const { tenantId, windowDays, horizonDays } = input;
  await assertTenantRead(sb, userId, tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
  const { assertEntitled } = await import("@/modules/commercial/resolver.server");
  await assertEntitled(sb, tenantId, "forecasting", { propertyId: input.propertyId ?? null });

  const now = Date.now();
  const start = new Date(now - windowDays * DAY).toISOString();

  let ordersQuery = sb
    .from("restaurant_orders")
    .select("opened_at, total, currency, payment_state")
    .eq("tenant_id", tenantId)
    .eq("status", "closed")
    .neq("payment_state", "refunded")
    .gte("opened_at", start);
  if (input.propertyId) ordersQuery = ordersQuery.eq("property_id", input.propertyId);
  if (input.locationId) ordersQuery = ordersQuery.eq("location_id", input.locationId);

  const [{ data: orderRows }, purchasing] = await Promise.all([
    ordersQuery,
    getPurchasingIntelligence(sb, userId, {
      tenantId,
      windowDays,
      propertyId: input.propertyId ?? undefined,
      locationId: input.locationId ?? undefined,
    }),
  ]);

  const orders = (orderRows ?? []) as any[];
  const currency = orders[0]?.currency ?? purchasing.currency ?? "TZS";

  const orderCountByDay = new Map<string, number>();
  const revenueByDay = new Map<string, number>();
  for (const o of orders) {
    const day = String(o.opened_at).slice(0, 10);
    orderCountByDay.set(day, (orderCountByDay.get(day) ?? 0) + 1);
    revenueByDay.set(day, (revenueByDay.get(day) ?? 0) + Number(o.total ?? 0));
  }
  const endIso = new Date(now).toISOString();
  const dailyOrders = fillDailySeries(orderCountByDay, start, endIso);
  const dailyRevenue = fillDailySeries(revenueByDay, start, endIso);

  const salesDemand = forecastFromDailySeries(dailyOrders, horizonDays);
  const revenue = forecastFromDailySeries(dailyRevenue, horizonDays);

  const inventorySufficiency = assessDataSufficiency(
    purchasing.suggestions.length,
    Math.min(windowDays, purchasing.windowDays),
  );

  const insights: RestaurantInsight[] = [];
  if (salesDemand.method === "insufficient_data") {
    insights.push({
      key: "forecasting.demand.insufficient_data",
      severity: "info",
      title: "Not enough order history to forecast demand yet",
      detail: salesDemand.limitations.join(" "),
    });
  } else {
    insights.push({
      key: "forecasting.demand.projection",
      severity: "info",
      title: `Sales demand projected to average ${round((salesDemand.dailyAverage ?? 0) + (salesDemand.trendPerDay ?? 0) * horizonDays, 1)} orders/day over the next ${horizonDays} days`,
      detail: `Straight-line trend from ${salesDemand.historicalBasisDays} days of history (${salesDemand.sufficiency.replace(/_/g, " ").toLowerCase()}).`,
      metric: `${salesDemand.horizonTotal ?? 0} orders projected`,
    });
  }
  if (revenue.method === "linear_trend" && revenue.trendPerDay != null && revenue.trendPerDay < 0) {
    insights.push({
      key: "forecasting.revenue.declining_trend",
      severity: "medium",
      title: "Revenue trend is projected to decline",
      detail: `The observed trend implies ${currency} ${round(Math.abs(revenue.trendPerDay), 2).toLocaleString()} less revenue per day, continued.`,
      recommendation:
        "Review recent pricing, demand, and outlet performance before this compounds.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    horizonDays,
    currency,
    salesDemand,
    revenue,
    inventoryRequirement: {
      sufficiency: inventorySufficiency.state,
      limitations:
        purchasing.suggestions.length === 0
          ? ["No inventory items currently show forecast-driven purchase requirements."]
          : [],
      items: purchasing.suggestions.slice(0, 20).map((s) => ({
        inventoryItemId: s.inventoryItemId,
        name: s.name,
        recommendedQuantity: s.recommendedQuantity,
        estimatedCost: s.estimatedCost,
        leadTimeDays: s.leadTimeDays,
        coverDays: s.coverDays,
      })),
    },
    insights,
  };
}
