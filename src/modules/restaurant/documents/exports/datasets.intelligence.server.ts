/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows/engine outputs are untyped at this boundary. */
/**
 * Pro Intelligence dataset exports.
 *
 * Every sheet below is built from the exact same engine call the Pro
 * Intelligence screen itself makes (getRevenueIntelligence, getMenuIntelligence,
 * ...) — never a second derivation of the numbers, and never a raw-table
 * re-query. The engine's own assertTenantRead/assertEntitled calls are the
 * authorization and tenant/property/outlet scope boundary for this export,
 * identical to what the screen enforces; datasets.server.ts's own
 * `assertCapability(..., "intelligence.read")` is only the coarse RBAC gate
 * every export type gets before dispatch.
 */
import { fileStem } from "../core/format";
import type { ExportSheet, ExportWorkbook } from "./model";
import type { DatasetInput } from "./datasets.server";

type Sb = any;
const joinEvidence = (evidence: Array<{ label: string; value: string }>) =>
  evidence.map((e) => `${e.label}: ${e.value}`).join("; ");
const joinList = (items: string[]) => items.join("; ");

export const INTELLIGENCE_EXPORT_TYPES = [
  "revenue_intelligence",
  "menu_intelligence",
  "demand_intelligence",
  "forecasting_intelligence",
  "inventory_intelligence_pro",
  "advanced_analytics",
  "executive_intelligence",
  "multi_location_intelligence",
] as const;

interface Base {
  type: string;
  title: string;
  metadata: ExportWorkbook["metadata"];
}

/**
 * DocumentCentre's shared date-range picker (from/to) drives every other
 * export; intelligence exports are windowDays-based (p05WindowSchema), so an
 * explicit windowDays wins, otherwise the picker's own range is converted —
 * clamped to p05WindowSchema's own [7, 120] bounds — rather than silently
 * ignoring what the user picked and falling back to a fixed 30 days.
 */
export function resolveWindowDays(input: DatasetInput): number {
  if (input.windowDays != null) return input.windowDays;
  if (input.from && input.to) {
    const days = Math.round(
      (new Date(`${input.to}T00:00:00Z`).getTime() -
        new Date(`${input.from}T00:00:00Z`).getTime()) /
        864e5,
    );
    if (Number.isFinite(days) && days > 0) return Math.min(120, Math.max(7, days));
  }
  return 30;
}

export async function buildIntelligenceDataset(
  sb: Sb,
  userId: string,
  input: DatasetInput,
  base: Base,
  label: string,
): Promise<ExportWorkbook> {
  const windowDays = resolveWindowDays(input);
  const scoped = {
    tenantId: input.tenantId,
    windowDays,
    propertyId: input.propertyId ?? undefined,
    locationId: input.locationId ?? undefined,
  };

  switch (input.type) {
    case "revenue_intelligence": {
      const mod = await import("../../intelligence/revenue.server");
      const r = await mod.getRevenueIntelligence(sb, userId, scoped);
      const sheets: ExportSheet[] = [
        {
          name: "Sales Composition",
          columns: [
            { key: "grossSales", label: "Gross Sales", format: "money" },
            { key: "discountTotal", label: "Discount", format: "money" },
            { key: "taxTotal", label: "Tax", format: "money" },
            { key: "serviceChargeTotal", label: "Service Charge", format: "money" },
            { key: "netSales", label: "Net Sales", format: "money" },
            { key: "cashCollected", label: "Cash Collected", format: "money" },
            { key: "outstandingAmount", label: "Outstanding", format: "money" },
          ],
          rows: [r.salesComposition as any],
        },
        {
          name: "Daily Series",
          columns: [
            { key: "date", label: "Date", format: "date" },
            { key: "revenue", label: "Revenue", format: "money" },
            { key: "orders", label: "Orders", format: "integer" },
          ],
          rows: r.series as any,
        },
        {
          name: "Top Contributors",
          columns: [
            { key: "name", label: "Item" },
            { key: "revenue", label: "Revenue", format: "money" },
            { key: "quantitySold", label: "Quantity Sold", format: "number" },
            { key: "revenueSharePercent", label: "Revenue Share %", format: "percent" },
            { key: "marginPercent", label: "Margin %", format: "percent" },
            { key: "marginSource", label: "Margin Source" },
          ],
          rows: r.topContributors as any,
        },
        {
          name: "By Outlet",
          columns: [
            { key: "name", label: "Outlet" },
            { key: "revenue", label: "Revenue", format: "money" },
            { key: "orders", label: "Orders", format: "integer" },
            { key: "averageOrderValue", label: "Average Order Value", format: "money" },
          ],
          rows: r.byOutlet as any,
        },
      ];
      return {
        ...base,
        fileStem: fileStem(["revenue-intelligence", String(windowDays)]),
        metadata: {
          ...base.metadata,
          dateRange: `Trailing ${windowDays} days`,
          rowCount: sheets.reduce((s, sh) => s + sh.rows.length, 0),
        },
        sheets,
      };
    }

    case "menu_intelligence": {
      const mod = await import("../../intelligence/menu.server");
      const r = await mod.getMenuIntelligence(sb, userId, scoped);
      const columns: ExportSheet["columns"] = [
        { key: "name", label: "Item" },
        { key: "quantitySold", label: "Quantity Sold", format: "number" },
        { key: "revenue", label: "Revenue", format: "money" },
        { key: "cost", label: "Cost", format: "money" },
        { key: "grossProfit", label: "Gross Profit", format: "money" },
        { key: "marginPercent", label: "Margin %", format: "percent" },
        { key: "foodCostPercent", label: "Food Cost %", format: "percent" },
        { key: "trendPercent", label: "Trend %", format: "percent" },
        { key: "classification", label: "Classification" },
        { key: "needsCostReview", label: "Needs Cost Review" },
        { key: "promote", label: "Promote" },
      ];
      return {
        ...base,
        fileStem: fileStem(["menu-intelligence", String(windowDays)]),
        metadata: {
          ...base.metadata,
          dateRange: `Trailing ${windowDays} days`,
          rowCount: r.items.length,
        },
        sheets: [{ name: "Menu Items", columns, rows: r.items as any }],
      };
    }

    case "demand_intelligence": {
      const mod = await import("../../intelligence/demand.server");
      const r = await mod.getDemandIntelligence(sb, userId, scoped);
      const itemColumns: ExportSheet["columns"] = [
        { key: "name", label: "Item" },
        { key: "quantitySold", label: "Quantity Sold", format: "number" },
        { key: "previousQuantitySold", label: "Previous Quantity Sold", format: "number" },
        { key: "trendPercent", label: "Trend %", format: "percent" },
        { key: "trend", label: "Trend" },
      ];
      const sheets: ExportSheet[] = [
        { name: "Top Items", columns: itemColumns, rows: r.topItems as any },
        { name: "Emerging Items", columns: itemColumns, rows: r.emergingItems as any },
        { name: "Declining Items", columns: itemColumns, rows: r.decliningItems as any },
        {
          name: "By Day Of Week",
          columns: [
            { key: "label", label: "Day" },
            { key: "orders", label: "Orders", format: "integer" },
            { key: "averageOrdersPerOccurrence", label: "Avg Orders", format: "number" },
            { key: "covers", label: "Covers", format: "integer" },
          ],
          rows: r.byDayOfWeek as any,
        },
        {
          name: "By Service Period",
          columns: [
            { key: "name", label: "Service Period" },
            { key: "orders", label: "Orders", format: "integer" },
            { key: "covers", label: "Covers", format: "integer" },
            { key: "revenue", label: "Revenue", format: "money" },
          ],
          rows: r.byServicePeriod as any,
        },
      ];
      return {
        ...base,
        fileStem: fileStem(["demand-intelligence", String(windowDays)]),
        metadata: {
          ...base.metadata,
          dateRange: `Trailing ${windowDays} days`,
          rowCount: sheets.reduce((s, sh) => s + sh.rows.length, 0),
        },
        sheets,
      };
    }

    case "forecasting_intelligence": {
      const mod = await import("../../intelligence/forecasting.server");
      const r = await mod.getForecastingIntelligence(sb, userId, {
        ...scoped,
        horizonDays: input.horizonDays ?? 14,
      });
      const pointColumns: ExportSheet["columns"] = [
        { key: "date", label: "Date", format: "date" },
        { key: "projected", label: "Projected", format: "number" },
      ];
      const sheets: ExportSheet[] = [
        {
          name: "Sales Demand Forecast",
          columns: pointColumns,
          rows: r.salesDemand.points as any,
        },
        {
          name: "Revenue Forecast",
          columns: pointColumns,
          rows: r.revenue.points as any,
        },
        {
          name: "Inventory Requirement",
          columns: [
            { key: "name", label: "Item" },
            { key: "recommendedQuantity", label: "Recommended Quantity", format: "number" },
            { key: "estimatedCost", label: "Estimated Cost", format: "money" },
            { key: "leadTimeDays", label: "Lead Time (days)", format: "integer" },
            { key: "coverDays", label: "Cover (days)", format: "integer" },
          ],
          rows: r.inventoryRequirement.items as any,
        },
      ];
      return {
        ...base,
        fileStem: fileStem(["forecasting-intelligence", String(windowDays)]),
        metadata: {
          ...base.metadata,
          dateRange: `Trailing ${windowDays} days, ${r.horizonDays}-day horizon`,
          rowCount: sheets.reduce((s, sh) => s + sh.rows.length, 0),
          filters: {
            ...base.metadata.filters,
            "Sales Method": r.salesDemand.method,
            "Revenue Method": r.revenue.method,
          },
        },
        sheets,
      };
    }

    case "inventory_intelligence_pro": {
      const mod = await import("../../intelligence/inventoryPro.server");
      const r = await mod.getInventoryIntelligencePro(sb, userId, scoped);
      const sheets: ExportSheet[] = [
        {
          name: "Consumption Anomalies",
          columns: [
            { key: "name", label: "Item" },
            { key: "currentVelocity", label: "Current Velocity", format: "number" },
            { key: "previousVelocity", label: "Previous Velocity", format: "number" },
            { key: "changePercent", label: "Change %", format: "percent" },
            { key: "direction", label: "Direction" },
          ],
          rows: r.anomalies as any,
        },
        {
          name: "Reorder Requirements",
          columns: [
            { key: "name", label: "Item" },
            { key: "daysOfCover", label: "Days Of Cover", format: "number" },
            { key: "recommendedQuantity", label: "Recommended Quantity", format: "number" },
            { key: "estimatedCost", label: "Estimated Cost", format: "money" },
            { key: "supplierName", label: "Supplier" },
            { key: "leadTimeDays", label: "Lead Time (days)", format: "integer" },
          ],
          rows: r.reorderRequirements as any,
        },
      ];
      return {
        ...base,
        fileStem: fileStem(["inventory-intelligence-pro", String(windowDays)]),
        metadata: {
          ...base.metadata,
          dateRange: `Trailing ${windowDays} days`,
          rowCount: sheets.reduce((s, sh) => s + sh.rows.length, 0),
        },
        sheets,
      };
    }

    case "advanced_analytics": {
      const mod = await import("../../intelligence/advancedAnalytics.server");
      const r = await mod.getAdvancedAnalyticsIntelligence(sb, userId, scoped);
      const rows = r.correlations.map((c) => ({
        kind: c.kind,
        severity: c.severity,
        title: c.title,
        detail: c.detail,
        evidence: joinEvidence(c.evidence),
      }));
      return {
        ...base,
        fileStem: fileStem(["advanced-analytics", String(windowDays)]),
        metadata: {
          ...base.metadata,
          dateRange: `Trailing ${windowDays} days`,
          rowCount: rows.length,
        },
        sheets: [
          {
            name: "Correlations",
            columns: [
              { key: "kind", label: "Kind" },
              { key: "severity", label: "Severity" },
              { key: "title", label: "Title" },
              { key: "detail", label: "Detail" },
              { key: "evidence", label: "Evidence" },
            ],
            rows: rows as any,
          },
        ],
      };
    }

    case "executive_intelligence": {
      const mod = await import("../../intelligence/executive.server");
      const r = await mod.getExecutiveIntelligence(sb, userId, scoped);
      const summaryRow = {
        overallHealth: r.overallHealth,
        healthReasons: joinList(r.healthReasons),
        revenueTotal: r.revenue.total,
        revenueTrendPercent: r.revenue.trendPercent,
        revenueSummary: r.revenue.summary,
        inventoryAtRiskCount: r.inventoryRisk.atRiskCount,
        inventoryCriticalCount: r.inventoryRisk.criticalCount,
        inventorySummary: r.inventoryRisk.summary,
        demandOrderTrendPercent: r.demandOutlook.orderTrendPercent,
        demandSummary: r.demandOutlook.summary,
        menuStarCount: r.menuPerformance.starCount,
        menuDogCount: r.menuPerformance.dogCount,
        menuSummary: r.menuPerformance.summary,
        marginDataAvailable: r.costMargin.available,
        marginSummary: r.costMargin.summary,
      };
      const insightColumns: ExportSheet["columns"] = [
        { key: "severity", label: "Severity" },
        { key: "title", label: "Title" },
        { key: "detail", label: "Detail" },
        { key: "metric", label: "Metric" },
        { key: "recommendation", label: "Recommendation" },
      ];
      const sheets: ExportSheet[] = [
        {
          name: "Health Summary",
          columns: [
            { key: "overallHealth", label: "Overall Health" },
            { key: "healthReasons", label: "Health Reasons" },
            { key: "revenueTotal", label: "Revenue Total", format: "money" },
            { key: "revenueTrendPercent", label: "Revenue Trend %", format: "percent" },
            { key: "revenueSummary", label: "Revenue Summary" },
            { key: "inventoryAtRiskCount", label: "Inventory At Risk Count", format: "integer" },
            { key: "inventoryCriticalCount", label: "Inventory Critical Count", format: "integer" },
            { key: "inventorySummary", label: "Inventory Summary" },
            { key: "demandOrderTrendPercent", label: "Demand Order Trend %", format: "percent" },
            { key: "demandSummary", label: "Demand Summary" },
            { key: "menuStarCount", label: "Menu Star Count", format: "integer" },
            { key: "menuDogCount", label: "Menu Dog Count", format: "integer" },
            { key: "menuSummary", label: "Menu Summary" },
            { key: "marginDataAvailable", label: "Margin Data Available" },
            { key: "marginSummary", label: "Margin Summary" },
          ],
          rows: [summaryRow as any],
        },
        {
          name: "Significant Anomalies",
          columns: insightColumns,
          rows: r.significantAnomalies as any,
        },
        {
          name: "Priority Recommendations",
          columns: insightColumns,
          rows: r.priorityRecommendations as any,
        },
      ];
      return {
        ...base,
        fileStem: fileStem(["executive-intelligence", String(windowDays)]),
        metadata: {
          ...base.metadata,
          dateRange: `Trailing ${windowDays} days`,
          rowCount: sheets.reduce((s, sh) => s + sh.rows.length, 0),
        },
        sheets,
      };
    }

    case "multi_location_intelligence": {
      const mod = await import("../../intelligence/multiLocation.server");
      const r = await mod.getMultiLocationIntelligence(sb, userId, {
        tenantId: input.tenantId,
        windowDays,
        propertyId: input.propertyId ?? undefined,
      });
      const sheets: ExportSheet[] = [
        {
          name: "Locations",
          columns: [
            { key: "name", label: "Location" },
            { key: "propertyId", label: "Property ID" },
            { key: "revenue", label: "Revenue", format: "money" },
            { key: "orders", label: "Orders", format: "integer" },
            { key: "atRiskInventoryCount", label: "At-Risk Inventory Count", format: "integer" },
          ],
          rows: r.locations.map((l) => ({
            name: l.name,
            propertyId: l.propertyId,
            revenue: l.revenue,
            orders: l.orders,
            atRiskInventoryCount: l.atRiskInventoryCount,
          })) as any,
        },
        {
          name: "Property Rollups",
          columns: [
            { key: "name", label: "Property" },
            { key: "revenue", label: "Revenue", format: "money" },
            { key: "orders", label: "Orders", format: "integer" },
            { key: "atRiskInventoryCount", label: "At-Risk Inventory Count", format: "integer" },
            { key: "outletCount", label: "Outlet Count", format: "integer" },
          ],
          rows: r.propertyRollups as any,
        },
      ];
      return {
        ...base,
        fileStem: fileStem(["multi-location-intelligence", String(windowDays)]),
        metadata: {
          ...base.metadata,
          dateRange: `Trailing ${windowDays} days`,
          rowCount: sheets.reduce((s, sh) => s + sh.rows.length, 0),
        },
        sheets,
      };
    }

    default:
      throw new Error(`${label} has no intelligence dataset exporter.`);
  }
}
