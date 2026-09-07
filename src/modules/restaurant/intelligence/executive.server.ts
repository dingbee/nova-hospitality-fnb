/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P05 §11 — Executive Intelligence (Pro).
 *
 * Not another dashboard: a synthesis layer that reads the SAME already-
 * computed outputs the other P05/Phase-3 engines produce and reduces them to
 * the five questions an owner actually asks — how is the business doing,
 * what changed, why, what matters, what should I do — in concise language.
 * Nothing here recomputes a number; every field traces back to a domain
 * engine's own output (menu.server.ts, inventory.server.ts,
 * demand.server.ts, revenue.server.ts).
 *
 * Calls the same Pro-gated demand/revenue engines directly rather than
 * re-deriving their trend math — safe because this codebase's P05
 * entitlement rows grant the whole Pro capability bundle together (see the
 * activation SQL in the P05 migration), so a tenant entitled to
 * "executive_intelligence" is always also entitled to its inputs.
 */
import { assertTenantRead } from "../core/access.server";
import { getDemandIntelligence } from "./demand.server";
import { getInventoryIntelligence } from "./inventory.server";
import { getMenuIntelligence } from "./menu.server";
import { getRevenueIntelligence } from "./revenue.server";
import { round } from "./analysis";
import type { RestaurantInsight } from "./types";
import type { ExecutiveIntelligence, OperationalHealth, P05WindowInput } from "./p05.types";

type Sb = any;

const SEVERITY_WEIGHT: Record<RestaurantInsight["severity"], number> = {
  info: 0,
  low: 1,
  medium: 3,
  high: 6,
  critical: 10,
};

export async function getExecutiveIntelligence(
  sb: Sb,
  userId: string,
  input: P05WindowInput,
): Promise<ExecutiveIntelligence> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId, {
    propertyId: input.propertyId ?? null,
    locationId: input.locationId ?? null,
  });
  const { assertEntitled } = await import("@/modules/commercial/resolver.server");
  await assertEntitled(sb, tenantId, "executive_intelligence", {
    propertyId: input.propertyId ?? null,
  });

  const scoped = {
    tenantId,
    windowDays,
    propertyId: input.propertyId ?? undefined,
    locationId: input.locationId ?? undefined,
  };
  const [menu, inventory, demand, revenue] = await Promise.all([
    getMenuIntelligence(sb, userId, scoped),
    getInventoryIntelligence(sb, userId, scoped),
    getDemandIntelligence(sb, userId, input),
    getRevenueIntelligence(sb, userId, input),
  ]);

  const allInsights: RestaurantInsight[] = [
    ...menu.insights,
    ...inventory.insights,
    ...demand.insights,
    ...revenue.insights,
  ];
  const significantAnomalies = [...allInsights]
    .filter((i) => i.severity === "high" || i.severity === "critical")
    .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity])
    .slice(0, 6);
  const priorityRecommendations = [...allInsights]
    .filter((i) => Boolean(i.recommendation))
    .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity])
    .slice(0, 6);

  const criticalCount = inventory.atRisk.filter(
    (r) => (r.daysOfCover ?? 99) <= 2 || r.belowReorder,
  ).length;
  const atRiskCount = inventory.atRisk.length;

  // Overall health: a deterministic weighted rollup of the same signals
  // above — no hidden model, just named weights, mirroring the
  // commercial-health scoring pattern (health.ts).
  let healthScore = 0;
  const healthReasons: string[] = [];
  if (criticalCount > 0) {
    healthScore += 40;
    healthReasons.push(`${criticalCount} inventory item(s) at critical stock risk.`);
  } else if (atRiskCount > 0) {
    healthScore += 15;
    healthReasons.push(`${atRiskCount} inventory item(s) at elevated stock risk.`);
  }
  if (revenue.revenueTrendPercent != null && revenue.revenueTrendPercent <= -15) {
    healthScore += 30;
    healthReasons.push(
      `Revenue is down ${Math.abs(revenue.revenueTrendPercent)}% vs the prior window.`,
    );
  } else if (revenue.revenueTrendPercent != null && revenue.revenueTrendPercent < 0) {
    healthScore += 10;
    healthReasons.push(
      `Revenue is down ${Math.abs(revenue.revenueTrendPercent)}% vs the prior window.`,
    );
  }
  if (demand.orderTrendPercent != null && demand.orderTrendPercent <= -15) {
    healthScore += 15;
    healthReasons.push(
      `Order volume is down ${Math.abs(demand.orderTrendPercent)}% vs the prior window.`,
    );
  }
  const dogCount = menu.items.filter((i) => i.classification === "dog").length;
  if (dogCount >= 3) {
    healthScore += 10;
    healthReasons.push(`${dogCount} menu items are neither popular nor profitable.`);
  }

  const overallHealth: OperationalHealth =
    healthScore >= 50
      ? "critical"
      : healthScore >= 25
        ? "needs_attention"
        : healthScore >= 10
          ? "stable"
          : "strong";
  if (healthReasons.length === 0) healthReasons.push("No material risk signals in this window.");

  const starCount = menu.items.filter((i) => i.classification === "star").length;

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    currency: revenue.currency,
    overallHealth,
    healthReasons,
    revenue: {
      total: revenue.totalRevenue,
      trendPercent: revenue.revenueTrendPercent,
      summary:
        revenue.revenueTrendPercent == null
          ? `${revenue.currency} ${round(revenue.totalRevenue).toLocaleString()} in revenue this window.`
          : `${revenue.currency} ${round(revenue.totalRevenue).toLocaleString()} in revenue, ${revenue.revenueTrendPercent > 0 ? "up" : "down"} ${Math.abs(revenue.revenueTrendPercent)}% vs the prior ${windowDays} days.`,
    },
    inventoryRisk: {
      atRiskCount,
      criticalCount,
      summary:
        criticalCount > 0
          ? `${criticalCount} item(s) need urgent reordering.`
          : atRiskCount > 0
            ? `${atRiskCount} item(s) approaching reorder point.`
            : "Stock levels are comfortable.",
    },
    demandOutlook: {
      orderTrendPercent: demand.orderTrendPercent,
      summary:
        demand.orderTrendPercent == null
          ? "Not enough history to characterise the demand trend."
          : `Order volume is ${demand.orderTrendPercent > 0 ? "up" : "down"} ${Math.abs(demand.orderTrendPercent)}% vs the prior ${windowDays} days.`,
    },
    menuPerformance: {
      starCount,
      dogCount,
      summary: `${starCount} star item(s), ${dogCount} underperforming item(s) on the current menu.`,
    },
    costMargin: {
      available: revenue.marginDataAvailable,
      summary: revenue.marginDataAvailable
        ? "Margin data is available from recent profitability snapshots."
        : "No profitability snapshots computed for this window — margin cannot be assessed yet.",
    },
    significantAnomalies,
    priorityRecommendations,
  };
}
