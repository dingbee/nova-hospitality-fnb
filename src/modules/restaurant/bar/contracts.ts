/**
 * Bar Operations contracts (Sprint 5.6) — browser-safe.
 *
 * The bar is not a new domain: it is the existing location / station /
 * requisition / ledger / recipe architecture, viewed through a beverage lens.
 * These contracts only describe *reads* over that architecture plus the two
 * genuinely new writes (pour configuration and complimentary drinks).
 */
import { z } from "zod";

const uuid = z.string().uuid();

/** Location types that behave as a bar service point. Configurable per tenant. */
export const BAR_LOCATION_TYPES = ["bar"] as const;
/** Station types that prepare beverages. */
export const BAR_STATION_TYPES = ["bar", "cocktail", "coffee", "service_bar", "beverage"] as const;

/** Suggested beverage catalogue — seeded through the existing category system. */
export const BAR_CATEGORY_SUGGESTIONS = [
  "Spirits",
  "Wine",
  "Beer",
  "Soft Drinks",
  "Juices",
  "Water",
  "Coffee",
  "Tea",
  "Cocktails",
  "Mocktails",
  "Mixers",
  "Garnishes",
  "Bar Consumables",
] as const;

/** Investigation categories for beverage variance. */
export const BAR_VARIANCE_REASONS = [
  { code: "over_pouring", label: "Over-pouring" },
  { code: "spillage", label: "Spillage" },
  { code: "complimentary", label: "Complimentary" },
  { code: "wastage", label: "Wastage" },
  { code: "breakage", label: "Breakage" },
  { code: "recipe_variance", label: "Recipe variance" },
  { code: "counting_error", label: "Counting error" },
  { code: "transfer_variance", label: "Transfer variance" },
  { code: "unrecorded_consumption", label: "Unrecorded consumption" },
  { code: "other", label: "Other" },
] as const;

export const barSnapshotSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
});
export type BarSnapshotInput = z.infer<typeof barSnapshotSchema>;

export const listBeveragesSchema = z.object({
  tenantId: uuid,
  search: z.string().max(120).optional(),
  includeNonBeverage: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(200),
});
export type ListBeveragesInput = z.infer<typeof listBeveragesSchema>;

export const savePourConfigSchema = z.object({
  tenantId: uuid,
  inventoryItemId: uuid,
  isBeverage: z.boolean(),
  /** Null clears the configured pour. */
  servingSize: z.number().min(0).nullable(),
  servingUnitId: uuid.nullable(),
});
export type SavePourConfigInput = z.infer<typeof savePourConfigSchema>;

export const beverageVarianceSchema = z.object({
  tenantId: uuid,
  locationId: uuid.optional(),
  from: z.string(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(300).default(120),
});
export type BeverageVarianceInput = z.infer<typeof beverageVarianceSchema>;

export const flagVarianceSchema = z.object({
  tenantId: uuid,
  inventoryItemId: uuid,
  locationId: uuid.optional(),
  reasonCode: z.string().min(2).max(40),
  expected: z.number(),
  actual: z.number(),
  notes: z.string().max(1000).optional(),
});
export type FlagVarianceInput = z.infer<typeof flagVarianceSchema>;

export const compDrinkSchema = z.object({
  tenantId: uuid,
  orderItemId: uuid,
  reason: z.string().min(2).max(200),
  comp: z.boolean().default(true),
});
export type CompDrinkInput = z.infer<typeof compDrinkSchema>;

/* ---------------- Read models ---------------- */

export interface BarLocationSummary {
  id: string;
  name: string;
  locationType: string;
  parentId: string | null;
  isStorage: boolean;
}

export interface BarStationSummary {
  id: string;
  name: string;
  stationType: string;
  locationId: string | null;
  targetPrepMinutes: number | null;
  active: boolean;
}

export interface BarTicket {
  id: string;
  ticketNumber: string | null;
  stationId: string | null;
  stationName: string;
  status: string;
  queuedAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
  isDelayed: boolean;
  targetMinutes: number | null;
  waitingSeconds: number;
  notes: string | null;
}

export interface BarBeverage {
  itemId: string;
  name: string;
  sku: string | null;
  categoryId: string | null;
  onHand: number;
  reorderPoint: number | null;
  parLevel: number | null;
  averageCost: number;
  currency: string;
  stockUnitCode: string | null;
  servingSize: number | null;
  servingUnitId: string | null;
  servingUnitCode: string | null;
  poursPerStockUnit: number | null;
  stockPerPour: number | null;
  pourCost: number | null;
  poursAvailable: number | null;
  low: boolean;
  pourIssue?: string;
}

export interface BarVarianceRow {
  itemId: string;
  name: string;
  unitCode: string | null;
  opening: number;
  received: number;
  transferredIn: number;
  transferredOut: number;
  theoreticalConsumption: number;
  wastage: number;
  expectedClosing: number;
  actualClosing: number | null;
  actualSource: "stocktake" | "ledger";
  variance: number | null;
  variancePercent: number | null;
  varianceValue: number | null;
  currency: string;
}

export interface BarSnapshot {
  locations: BarLocationSummary[];
  stations: BarStationSummary[];
  tickets: BarTicket[];
  openTicketCount: number;
  delayedTicketCount: number;
  pendingRequisitions: Array<{ id: string; reference: string; status: string; createdAt: string }>;
  openTransfers: Array<{ id: string; transferNumber: string; status: string; createdAt: string }>;
  lowStock: Array<{ itemId: string; name: string; onHand: number; reorderPoint: number | null }>;
  expiring: Array<{ batchId: string; itemName: string; batchNumber: string | null; expiryDate: string; quantity: number }>;
  sales: {
    currency: string;
    net: number;
    quantity: number;
    theoreticalCost: number;
    grossProfit: number;
    costPercent: number | null;
    compCount: number;
    compValue: number;
    voidCount: number;
  };
}