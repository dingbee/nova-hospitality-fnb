/**
 * P05 — Restaurant Intelligence / Pro Intelligence Completion.
 *
 * Browser-safe contracts for the six primary Pro capabilities plus the
 * secondary Multi-Location Command capability. Mirrors the Phase-3
 * discipline in types.ts: every shape here describes *advisory* output
 * computed from existing operational tables — nothing is written back,
 * and every number traces to a named authoritative source.
 */
import { z } from "zod";
import type { RestaurantInsight } from "./types";
import type { DataSufficiency } from "./sufficiency";
import type { ForecastResult } from "./forecast";

export const p05WindowSchema = z.object({
  tenantId: z.string().uuid(),
  windowDays: z.number().int().min(7).max(120).default(30),
  propertyId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
});
export type P05WindowInput = z.infer<typeof p05WindowSchema>;

export const p05ForecastWindowSchema = p05WindowSchema.extend({
  horizonDays: z.number().int().min(1).max(60).default(14),
});
export type P05ForecastWindowInput = z.infer<typeof p05ForecastWindowSchema>;

export const p05MultiLocationWindowSchema = z.object({
  tenantId: z.string().uuid(),
  windowDays: z.number().int().min(7).max(120).default(30),
  propertyId: z.string().uuid().nullish(),
});
export type P05MultiLocationWindowInput = z.infer<typeof p05MultiLocationWindowSchema>;

/* --------------------------- Demand Intelligence --------------------------- */

export interface DayOfWeekDemand {
  /** 0 = Sunday .. 6 = Saturday, matching Date#getUTCDay. */
  dayOfWeek: number;
  label: string;
  orders: number;
  averageOrdersPerOccurrence: number;
  covers: number;
}

export interface ServicePeriodDemand {
  servicePeriodId: string | null;
  name: string;
  orders: number;
  covers: number;
  revenue: number;
}

export interface ItemDemandRow {
  menuItemId: string;
  name: string;
  quantitySold: number;
  previousQuantitySold: number;
  trendPercent: number | null;
  trend: "emerging" | "declining" | "stable";
}

export interface DemandIntelligence {
  generatedAt: string;
  windowDays: number;
  currency: string;
  sufficiency: DataSufficiency;
  sufficiencyReasons: string[];
  totalOrders: number;
  totalCovers: number;
  previousTotalOrders: number;
  orderTrendPercent: number | null;
  byDayOfWeek: DayOfWeekDemand[];
  byServicePeriod: ServicePeriodDemand[];
  topItems: ItemDemandRow[];
  emergingItems: ItemDemandRow[];
  decliningItems: ItemDemandRow[];
  insights: RestaurantInsight[];
}

/* ---------------------------- Forecasting ---------------------------- */

export interface ForecastingIntelligence {
  generatedAt: string;
  windowDays: number;
  horizonDays: number;
  currency: string;
  salesDemand: ForecastResult;
  revenue: ForecastResult;
  /** Per-inventory-item requirement forecast, reusing purchasing.server.ts's own recommendations rather than recomputing them — see file doc comment in forecasting.server.ts. */
  inventoryRequirement: {
    sufficiency: DataSufficiency;
    limitations: string[];
    items: Array<{
      inventoryItemId: string;
      name: string;
      recommendedQuantity: number;
      estimatedCost: number;
      leadTimeDays: number;
      coverDays: number;
    }>;
  };
  insights: RestaurantInsight[];
}

/* --------------------------- Revenue Intelligence --------------------------- */

export interface RevenuePeriodPoint {
  date: string;
  revenue: number;
  orders: number;
}

export interface RevenueItemContribution {
  menuItemId: string;
  name: string;
  revenue: number;
  quantitySold: number;
  revenueSharePercent: number;
  /** Only populated when restaurant_profitability_snapshots carries a costed row for this item in this window — never estimated. */
  marginPercent: number | null;
  marginSource: "profitability_snapshot" | "unavailable";
}

export interface OutletRevenuePerformance {
  locationId: string;
  name: string;
  revenue: number;
  orders: number;
  averageOrderValue: number;
}

export interface RevenueIntelligence {
  generatedAt: string;
  windowDays: number;
  currency: string;
  sufficiency: DataSufficiency;
  sufficiencyReasons: string[];
  totalRevenue: number;
  previousRevenue: number;
  revenueTrendPercent: number | null;
  totalOrders: number;
  averageOrderValue: number;
  series: RevenuePeriodPoint[];
  byServicePeriod: ServicePeriodDemand[];
  topContributors: RevenueItemContribution[];
  underperformers: RevenueItemContribution[];
  byOutlet: OutletRevenuePerformance[];
  marginDataAvailable: boolean;
  anomalies: RestaurantInsight[];
  insights: RestaurantInsight[];
}

/* -------------------------- Advanced Analytics -------------------------- */

export interface AnalyticsCorrelation {
  key: string;
  kind:
    | "high_sales_low_margin"
    | "slow_moving_stock"
    | "revenue_driver"
    | "inventory_risk_vs_demand"
    | "revenue_concentration";
  severity: RestaurantInsight["severity"];
  title: string;
  detail: string;
  evidence: Array<{ label: string; value: string }>;
}

export interface AdvancedAnalyticsIntelligence {
  generatedAt: string;
  windowDays: number;
  currency: string;
  sufficiency: DataSufficiency;
  correlations: AnalyticsCorrelation[];
  insights: RestaurantInsight[];
}

/* -------------------------- Executive Intelligence -------------------------- */

export type OperationalHealth = "strong" | "stable" | "needs_attention" | "critical";

export interface ExecutiveIntelligence {
  generatedAt: string;
  windowDays: number;
  currency: string;
  overallHealth: OperationalHealth;
  healthReasons: string[];
  revenue: { total: number; trendPercent: number | null; summary: string };
  inventoryRisk: { atRiskCount: number; criticalCount: number; summary: string };
  demandOutlook: { orderTrendPercent: number | null; summary: string };
  menuPerformance: { starCount: number; dogCount: number; summary: string };
  costMargin: { available: boolean; summary: string };
  significantAnomalies: RestaurantInsight[];
  priorityRecommendations: RestaurantInsight[];
}

/* -------------------------- Multi-Location Command -------------------------- */

export interface LocationSummary {
  locationId: string;
  name: string;
  propertyId: string | null;
  revenue: number;
  orders: number;
  atRiskInventoryCount: number;
  topInsight: RestaurantInsight | null;
}

export interface MultiLocationIntelligence {
  generatedAt: string;
  windowDays: number;
  currency: string;
  locations: LocationSummary[];
  bestPerforming: string | null;
  worstPerforming: string | null;
  insights: RestaurantInsight[];
}
