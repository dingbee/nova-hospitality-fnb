/**
 * Phase 3 — Restaurant Intelligence Activation (browser-safe contracts).
 *
 * These types describe *advisory* output only. The intelligence layer reads
 * operational tables and reasons; it never writes to another domain's tables.
 */
import { z } from "zod";

export const INSIGHT_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

export interface RestaurantInsight {
  key: string;
  severity: InsightSeverity;
  title: string;
  detail: string;
  /** Short headline metric, e.g. "2.5 days of cover". */
  metric?: string;
  recommendation?: string;
}

export const intelligenceWindowSchema = z.object({
  tenantId: z.string().uuid(),
  windowDays: z.number().int().min(7).max(120).default(30),
});
export type IntelligenceWindowInput = z.infer<typeof intelligenceWindowSchema>;

/* ------------------------------ 3.1 Menu ------------------------------ */

export const MENU_CLASSES = ["star", "plough_horse", "puzzle", "dog", "unsold"] as const;
export type MenuClass = (typeof MENU_CLASSES)[number];

export const MENU_CLASS_LABEL: Record<MenuClass, string> = {
  star: "Star",
  plough_horse: "Plough horse",
  puzzle: "Puzzle",
  dog: "Dog",
  unsold: "Not selling",
};

export interface MenuItemIntelligence {
  menuItemId: string;
  name: string;
  price: number | null;
  quantitySold: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  marginPercent: number | null;
  foodCostPercent: number | null;
  /** Quantity change vs the immediately preceding window, in %. */
  trendPercent: number | null;
  classification: MenuClass;
  /** True when there is no recipe cost, it is stale, or actual cost drifted. */
  needsCostReview: boolean;
  costReviewReason: string | null;
  promote: boolean;
}

export interface MenuIntelligence {
  generatedAt: string;
  windowDays: number;
  currency: string;
  totals: { revenue: number; cost: number; grossProfit: number; itemsSold: number };
  items: MenuItemIntelligence[];
  profitDrivers: MenuItemIntelligence[];
  marginLosers: MenuItemIntelligence[];
  declining: MenuItemIntelligence[];
  promote: MenuItemIntelligence[];
  costReview: MenuItemIntelligence[];
  insights: RestaurantInsight[];
}

/* --------------------------- 3.2 Inventory --------------------------- */

export interface StockRunwayRow {
  inventoryItemId: string;
  name: string;
  currentQuantity: number;
  dailyVelocity: number;
  daysOfCover: number | null;
  reorderPoint: number | null;
  belowReorder: boolean;
}

export interface WastageTrend {
  currentCost: number;
  previousCost: number;
  changePercent: number | null;
  topItems: Array<{ name: string; cost: number; quantity: number }>;
}

export interface SupplierPriceThreat {
  supplierName: string;
  itemName: string;
  supplierPrice: number;
  averageCost: number;
  increasePercent: number;
}

export interface InventoryIntelligence {
  generatedAt: string;
  windowDays: number;
  currency: string;
  runway: StockRunwayRow[];
  atRisk: StockRunwayRow[];
  wastage: WastageTrend;
  priceThreats: SupplierPriceThreat[];
  insights: RestaurantInsight[];
}

/* ---------------------------- 3.3 Kitchen ---------------------------- */

export interface StationPerformance {
  stationId: string;
  name: string;
  targetMinutes: number | null;
  tickets: number;
  averagePrepMinutes: number | null;
  peakPrepMinutes: number | null;
  delayedTickets: number;
  delayedPercent: number | null;
  overTarget: boolean;
  /** Average prep minutes during the dinner peak (17:00–22:00 local). */
  dinnerPeakMinutes: number | null;
}

export interface KitchenIntelligence {
  generatedAt: string;
  windowDays: number;
  ticketsAnalysed: number;
  averagePrepMinutes: number | null;
  previousAveragePrepMinutes: number | null;
  trendPercent: number | null;
  stations: StationPerformance[];
  insights: RestaurantInsight[];
}

/* --------------------------- 3.4 Purchasing --------------------------- */

export interface PurchaseSuggestion {
  inventoryItemId: string;
  name: string;
  currentQuantity: number;
  dailyVelocity: number;
  leadTimeDays: number;
  coverDays: number;
  recommendedQuantity: number;
  estimatedCost: number;
  supplierName: string | null;
  supplierId: string | null;
}

export interface SupplierReliability {
  supplierId: string;
  name: string;
  orders: number;
  onTime: number;
  onTimePercent: number | null;
  averageLeadTimeDays: number | null;
  declaredLeadTimeDays: number | null;
  score: number;
}

export interface PurchasingIntelligence {
  generatedAt: string;
  windowDays: number;
  currency: string;
  suggestions: PurchaseSuggestion[];
  suppliers: SupplierReliability[];
  expectedMonthlySpend: number;
  previousMonthlySpend: number;
  spendChangePercent: number | null;
  insights: RestaurantInsight[];
}