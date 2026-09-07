/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P05 §10 — Advanced Analytics (Pro).
 *
 * Not a second analytics engine: every correlation here is computed by
 * cross-referencing the OUTPUT of the existing, already-authoritative
 * engines (menu.server.ts, inventory.server.ts, purchasing.server.ts) —
 * nothing is re-derived from raw tables a second time. Deliberately calls
 * the ungated Phase-3 engines (not demand.server.ts/revenue.server.ts,
 * which are gated on their own sibling capabilities) so a tenant entitled
 * to "advanced_analytics" alone is never denied because of an unrelated
 * capability.
 *
 * Every correlation carries its own evidence array (the exact figures it
 * was derived from) so nothing here is a claim without a traceable number
 * behind it — Part 10's "every derived insight must show the underlying
 * evidence" applied literally.
 */
import { assertTenantRead } from "../core/access.server";
import { getInventoryIntelligence } from "./inventory.server";
import { getMenuIntelligence } from "./menu.server";
import { getPurchasingIntelligence } from "./purchasing.server";
import { round } from "./analysis";
import { assessDataSufficiency } from "./sufficiency";
import type { RestaurantInsight } from "./types";
import type {
  AdvancedAnalyticsIntelligence,
  AnalyticsCorrelation,
  P05WindowInput,
} from "./p05.types";

type Sb = any;

export async function getAdvancedAnalyticsIntelligence(
  sb: Sb,
  userId: string,
  input: P05WindowInput,
): Promise<AdvancedAnalyticsIntelligence> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
  const { assertEntitled } = await import("@/modules/commercial/resolver.server");
  await assertEntitled(sb, tenantId, "advanced_analytics", {
    propertyId: input.propertyId ?? null,
  });

  const [menu, inventory, purchasing] = await Promise.all([
    getMenuIntelligence(sb, userId, {
      tenantId,
      windowDays,
      propertyId: input.propertyId ?? undefined,
      locationId: input.locationId ?? undefined,
    }),
    getInventoryIntelligence(sb, userId, {
      tenantId,
      windowDays,
      propertyId: input.propertyId ?? undefined,
      locationId: input.locationId ?? undefined,
    }),
    getPurchasingIntelligence(sb, userId, {
      tenantId,
      windowDays,
      propertyId: input.propertyId ?? undefined,
      locationId: input.locationId ?? undefined,
    }),
  ]);

  const sufficiency = assessDataSufficiency(
    menu.totals.itemsSold,
    menu.items.length > 0 ? windowDays : 0,
  );
  const correlations: AnalyticsCorrelation[] = [];

  // 1) High sales, low margin — menu.server.ts's own "plough_horse" quadrant
  // (popular AND unprofitable), the exact cross-domain signal Part 10 names.
  const ploughHorses = menu.items
    .filter((i) => i.classification === "plough_horse")
    .sort((a, b) => b.quantitySold - a.quantitySold)
    .slice(0, 3);
  for (const item of ploughHorses) {
    correlations.push({
      key: `analytics.high_sales_low_margin.${item.menuItemId}`,
      kind: "high_sales_low_margin",
      severity: (item.marginPercent ?? 0) < 0 ? "high" : "medium",
      title: `${item.name} sells well but carries weak margin`,
      detail: `High sales volume is not translating into proportional profit — reprice or re-cost this item.`,
      evidence: [
        { label: "Quantity sold", value: String(item.quantitySold) },
        {
          label: "Margin",
          value: item.marginPercent != null ? `${item.marginPercent}%` : "unknown",
        },
        { label: "Revenue", value: `${menu.currency} ${round(item.revenue).toLocaleString()}` },
      ],
    });
  }

  // 2) Slow-moving stock — runway rows with negligible consumption velocity
  // but meaningful quantity still on hand (existing inventory.server.ts
  // computation, no new query).
  const slowMoving = inventory.runway
    .filter((r) => r.dailyVelocity < 0.1 && r.currentQuantity > 0)
    .sort((a, b) => b.currentQuantity - a.currentQuantity)
    .slice(0, 3);
  for (const item of slowMoving) {
    correlations.push({
      key: `analytics.slow_moving_stock.${item.inventoryItemId}`,
      kind: "slow_moving_stock",
      severity: "low",
      title: `${item.name} is barely moving`,
      detail: `${item.currentQuantity} units on hand with almost no consumption over the last ${windowDays} days.`,
      evidence: [
        { label: "On hand", value: String(item.currentQuantity) },
        { label: "Daily velocity", value: String(item.dailyVelocity) },
      ],
    });
  }

  // 3) Revenue drivers — menu.server.ts's own profitDrivers, cross-referenced
  // against total revenue to show concentration.
  const totalRevenue = menu.totals.revenue;
  for (const item of menu.profitDrivers.slice(0, 3)) {
    const share = totalRevenue > 0 ? round((item.revenue / totalRevenue) * 100, 1) : 0;
    correlations.push({
      key: `analytics.revenue_driver.${item.menuItemId}`,
      kind: "revenue_driver",
      severity: "info",
      title: `${item.name} is a top revenue driver`,
      detail: `Accounts for ${share}% of this window's revenue at a ${item.marginPercent ?? "unknown"}% margin.`,
      evidence: [
        { label: "Revenue share", value: `${share}%` },
        {
          label: "Gross profit",
          value: `${menu.currency} ${round(item.grossProfit).toLocaleString()}`,
        },
      ],
    });
  }

  // 4) Inventory risk consistent with forecast demand — an at-risk item that
  // also appears among purchasing's own forecast-driven suggestions (same
  // name), showing the shortage risk and the forecasted requirement agree
  // rather than contradict.
  const suggestionNames = new Set(purchasing.suggestions.map((s) => s.name));
  const consistentRisk = inventory.atRisk.filter((r) => suggestionNames.has(r.name)).slice(0, 3);
  for (const item of consistentRisk) {
    const suggestion = purchasing.suggestions.find((s) => s.name === item.name);
    correlations.push({
      key: `analytics.inventory_risk_vs_demand.${item.inventoryItemId}`,
      kind: "inventory_risk_vs_demand",
      severity: "medium",
      title: `${item.name}'s stock risk is confirmed by forecast demand`,
      detail: `Both the stock-runway signal and the purchasing forecast independently flag this item.`,
      evidence: [
        {
          label: "Days of cover",
          value: item.daysOfCover != null ? String(item.daysOfCover) : "below reorder point",
        },
        {
          label: "Forecast quantity to order",
          value: suggestion ? String(suggestion.recommendedQuantity) : "n/a",
        },
      ],
    });
  }

  // 5) Revenue concentration — the share of revenue coming from the top 20%
  // of menu items by revenue (a Pareto read on menu.server.ts's own totals).
  const sortedByRevenue = [...menu.items].sort((a, b) => b.revenue - a.revenue);
  const topCount = Math.max(1, Math.ceil(sortedByRevenue.length * 0.2));
  const topRevenue = sortedByRevenue.slice(0, topCount).reduce((s, i) => s + i.revenue, 0);
  const concentrationPercent = totalRevenue > 0 ? round((topRevenue / totalRevenue) * 100, 1) : 0;
  if (sortedByRevenue.length >= 5) {
    correlations.push({
      key: "analytics.revenue_concentration",
      kind: "revenue_concentration",
      severity: concentrationPercent >= 70 ? "medium" : "info",
      title: `${concentrationPercent}% of revenue comes from your top ${topCount} item(s)`,
      detail:
        concentrationPercent >= 70
          ? "Revenue is concentrated in a small number of items — a supply or demand shock to one of them has outsized impact."
          : "Revenue is reasonably distributed across the menu.",
      evidence: [
        { label: "Top items", value: `${topCount} of ${sortedByRevenue.length}` },
        { label: "Revenue share", value: `${concentrationPercent}%` },
      ],
    });
  }

  const insights: RestaurantInsight[] = correlations.map((c) => ({
    key: c.key,
    severity: c.severity,
    title: c.title,
    detail: c.detail,
    metric: c.evidence[0] ? `${c.evidence[0].label}: ${c.evidence[0].value}` : undefined,
  }));

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency: menu.currency,
    sufficiency: sufficiency.state,
    correlations,
    insights,
  };
}
