/**
 * Inventory Control contracts (Sprint 5.2) — browser-safe.
 *
 * The vocabulary this module insists on:
 *   on hand   — what the ledger says is physically there
 *   reserved  — committed to an operation, not yet consumed
 *   available — on hand minus reserved
 *   incoming  — expected from open, approved procurement
 * These are four different numbers and are never blended.
 */
import { z } from "zod";

const uuid = z.string().uuid();

/* ---------------- Locations ---------------- */

export const STORAGE_LOCATION_TYPES = [
  "restaurant",
  "bar",
  "kitchen",
  "banquet",
  "room_service",
  "cafe",
  "store",
  "dry_store",
  "cold_room",
  "freezer",
  "cellar",
  "outlet",
] as const;
export type StorageLocationType = (typeof STORAGE_LOCATION_TYPES)[number];

export const listLocationsSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  storageOnly: z.boolean().default(false),
  includeInactive: z.boolean().default(true),
});

export const upsertLocationSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  propertyId: uuid,
  parentId: uuid.nullish(),
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(120).regex(/^[a-z0-9-]+$/),
  code: z.string().max(40).optional(),
  locationType: z.string().min(2).max(40).default("store"),
  isStorage: z.boolean().default(true),
  active: z.boolean().default(true),
  notes: z.string().max(1000).optional(),
});
export type UpsertLocationInput = z.infer<typeof upsertLocationSchema>;

/* ---------------- Stock positions ---------------- */

export const stockPositionsSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  categoryId: uuid.optional(),
  itemId: uuid.optional(),
  lowOnly: z.boolean().default(false),
  search: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(1000).default(300),
});
export type StockPositionsInput = z.infer<typeof stockPositionsSchema>;

export interface LocationPosition {
  locationId: string | null;
  locationName: string;
  onHand: number;
  reserved: number;
  available: number;
  lastMovementAt: string | null;
}

export interface StockPosition {
  itemId: string;
  name: string;
  sku: string | null;
  categoryId: string | null;
  unitId: string | null;
  currency: string;
  averageCost: number;
  onHand: number;
  reserved: number;
  available: number;
  incoming: number;
  value: number;
  reorderPoint: number | null;
  parLevel: number | null;
  low: boolean;
  critical: boolean;
  trackBatches: boolean;
  allowNegative: boolean;
  lastMovementAt: string | null;
  locations: LocationPosition[];
}

/* ---------------- Transfers ---------------- */

export const TRANSFER_STATUSES = [
  "draft",
  "requested",
  "approved",
  "rejected",
  "dispatched",
  "partially_received",
  "received",
  "completed",
  "cancelled",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const listTransfersSchema = z.object({
  tenantId: uuid,
  status: z.enum(TRANSFER_STATUSES).optional(),
  locationId: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const createTransferSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  sourceLocationId: uuid,
  destinationLocationId: uuid,
  requiresApproval: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
  submit: z.boolean().default(true),
  lines: z
    .array(
      z.object({
        inventoryItemId: uuid,
        unitId: uuid.optional(),
        batchId: uuid.optional(),
        requestedQuantity: z.number().min(0.0001),
        notes: z.string().max(500).optional(),
      }),
    )
    .min(1),
});
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

export const approveTransferSchema = z.object({
  tenantId: uuid,
  transferId: uuid,
  approve: z.boolean(),
  reason: z.string().max(500).optional(),
});

export const dispatchTransferSchema = z.object({
  tenantId: uuid,
  transferId: uuid,
  notes: z.string().max(1000).optional(),
  lines: z
    .array(z.object({ lineId: uuid, dispatchedQuantity: z.number().min(0) }))
    .min(1),
});
export type DispatchTransferInput = z.infer<typeof dispatchTransferSchema>;

export const receiveTransferSchema = z.object({
  tenantId: uuid,
  transferId: uuid,
  notes: z.string().max(1000).optional(),
  lines: z
    .array(
      z.object({
        lineId: uuid,
        receivedQuantity: z.number().min(0),
        rejectedQuantity: z.number().min(0).default(0),
        damagedQuantity: z.number().min(0).default(0),
        notes: z.string().max(500).optional(),
      }),
    )
    .min(1),
});
export type ReceiveTransferInput = z.infer<typeof receiveTransferSchema>;

export const cancelTransferSchema = z.object({
  tenantId: uuid,
  transferId: uuid,
  reason: z.string().max(500).optional(),
});

/* ---------------- Waste & adjustments ---------------- */

export const DEFAULT_WASTE_REASONS = [
  { code: "spoilage", label: "Spoilage" },
  { code: "expiry", label: "Expiry" },
  { code: "preparation", label: "Preparation waste" },
  { code: "overproduction", label: "Overproduction" },
  { code: "spillage", label: "Spillage" },
  { code: "breakage", label: "Breakage" },
  { code: "damaged", label: "Damaged goods" },
  { code: "complimentary", label: "Complimentary" },
  { code: "unknown", label: "Unknown" },
] as const;

export const DEFAULT_ADJUSTMENT_REASONS = [
  { code: "counting_error", label: "Counting error" },
  { code: "damage", label: "Damage" },
  { code: "breakage", label: "Breakage" },
  { code: "shrinkage", label: "Shrinkage" },
  { code: "opening_balance", label: "Opening balance" },
  { code: "correction", label: "Correction" },
  { code: "reconciliation", label: "System reconciliation" },
] as const;

export const REASON_KINDS = ["waste", "adjustment", "transfer", "stocktake"] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

export const listReasonsSchema = z.object({
  tenantId: uuid,
  kind: z.enum(REASON_KINDS).optional(),
});

export const upsertReasonSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  kind: z.enum(REASON_KINDS),
  code: z.string().min(2).max(40).regex(/^[a-z0-9_]+$/),
  label: z.string().min(2).max(120),
  requiresApproval: z.boolean().default(false),
  requiresNote: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});
export type UpsertReasonInput = z.infer<typeof upsertReasonSchema>;

export const recordWasteSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  inventoryItemId: uuid,
  unitId: uuid.optional(),
  batchId: uuid.optional(),
  quantity: z.number().min(0.0001),
  reasonCode: z.string().min(2).max(40),
  notes: z.string().max(1000).optional(),
  occurredAt: z.string().optional(),
  dedupeKey: z.string().max(200).optional(),
});
export type RecordWasteInput = z.infer<typeof recordWasteSchema>;

export const recordAdjustmentSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  inventoryItemId: uuid,
  unitId: uuid.optional(),
  /** Signed: positive raises stock, negative lowers it. */
  quantity: z.number().refine((n) => n !== 0, "Adjustment quantity cannot be zero."),
  reasonCode: z.string().min(2).max(40),
  notes: z.string().max(1000).optional(),
  referenceType: z.string().max(60).optional(),
  referenceId: uuid.optional(),
  occurredAt: z.string().optional(),
  dedupeKey: z.string().max(200).optional(),
});
export type RecordAdjustmentInput = z.infer<typeof recordAdjustmentSchema>;

export const reverseMovementSchema = z.object({
  tenantId: uuid,
  movementId: uuid,
  reason: z.string().min(2).max(500),
});

/* ---------------- Reservations ---------------- */

export const RESERVATION_STATUSES = ["active", "released", "consumed", "expired"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const RESERVATION_PURPOSES = [
  "operational",
  "production",
  "catering",
  "event",
  "scheduled_service",
  "requisition",
] as const;
export type ReservationPurpose = (typeof RESERVATION_PURPOSES)[number];

export const listReservationsSchema = z.object({
  tenantId: uuid,
  locationId: uuid.optional(),
  inventoryItemId: uuid.optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
  limit: z.number().int().min(1).max(300).default(100),
});

export const createReservationSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  inventoryItemId: uuid,
  unitId: uuid.optional(),
  quantity: z.number().min(0.0001),
  purpose: z.enum(RESERVATION_PURPOSES).default("operational"),
  referenceType: z.string().max(60).optional(),
  referenceId: uuid.optional(),
  neededAt: z.string().optional(),
  expiresAt: z.string().optional(),
  notes: z.string().max(1000).optional(),
  dedupeKey: z.string().max(200).optional(),
});
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const releaseReservationSchema = z.object({
  tenantId: uuid,
  reservationId: uuid,
  status: z.enum(["released", "consumed", "expired"]).default("released"),
});

/* ---------------- Stocktake ---------------- */

export const STOCKTAKE_STATUSES = ["draft", "counting", "review", "approved", "posted", "cancelled"] as const;
export type StocktakeStatus = (typeof STOCKTAKE_STATUSES)[number];

export const STOCKTAKE_SCOPES = ["full", "location", "category", "selected"] as const;
export type StocktakeScope = (typeof STOCKTAKE_SCOPES)[number];

export const listStocktakesSchema = z.object({
  tenantId: uuid,
  status: z.enum(STOCKTAKE_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const startStocktakeSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  categoryId: uuid.optional(),
  scope: z.enum(STOCKTAKE_SCOPES).default("location"),
  itemIds: z.array(uuid).default([]),
  notes: z.string().max(2000).optional(),
});
export type StartStocktakeInput = z.infer<typeof startStocktakeSchema>;

export const saveStocktakeCountsSchema = z.object({
  tenantId: uuid,
  stocktakeId: uuid,
  submitForReview: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        lineId: uuid,
        countedQuantity: z.number().min(0),
        reasonCode: z.string().max(40).optional(),
        notes: z.string().max(500).optional(),
      }),
    )
    .min(1),
});
export type SaveStocktakeCountsInput = z.infer<typeof saveStocktakeCountsSchema>;

export const postStocktakeSchema = z.object({
  tenantId: uuid,
  stocktakeId: uuid,
  approve: z.boolean().default(true),
  reason: z.string().max(500).optional(),
});

/* ---------------- Batches ---------------- */

export const listBatchesSchema = z.object({
  tenantId: uuid,
  inventoryItemId: uuid.optional(),
  locationId: uuid.optional(),
  expiringWithinDays: z.number().int().min(0).max(365).optional(),
  limit: z.number().int().min(1).max(300).default(100),
});

export const upsertBatchSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  inventoryItemId: uuid,
  supplierId: uuid.optional(),
  batchNumber: z.string().min(1).max(80),
  receivedDate: z.string().optional(),
  expiryDate: z.string().optional(),
  quantity: z.number().min(0).default(0),
  unitId: uuid.optional(),
  unitCost: z.number().min(0).default(0),
  referenceType: z.string().max(60).optional(),
  referenceId: uuid.optional(),
  notes: z.string().max(1000).optional(),
});
export type UpsertBatchInput = z.infer<typeof upsertBatchSchema>;

/* ---------------- Overview & reconciliation ---------------- */

export const inventoryOverviewSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
});

export interface InventoryOverview {
  currency: string;
  totalStockValue: number;
  itemsBelowReorder: number;
  criticalItems: number;
  incomingToday: number;
  transfersPending: number;
  stocktakeVariances: number;
  expiringSoon: number;
  recentWasteValue: number;
  locations: number;
}

export const reconciliationSchema = z.object({
  tenantId: uuid,
  limit: z.number().int().min(1).max(500).default(200),
});

/* ---------------- Presentation helpers (shared by UI + exports) ---------------- */

export function transferBadge(status?: string | null): {
  label: string;
  tone: "success" | "warning" | "danger" | "info" | "neutral";
} {
  switch (status) {
    case "completed":
    case "received":
      return { label: (status ?? "").replace(/_/g, " "), tone: "success" };
    case "dispatched":
    case "partially_received":
      return { label: (status ?? "").replace(/_/g, " "), tone: "info" };
    case "requested":
    case "approved":
      return { label: status ?? "", tone: "warning" };
    case "rejected":
    case "cancelled":
      return { label: status ?? "", tone: "danger" };
    default:
      return { label: status ?? "draft", tone: "neutral" };
  }
}

export function stocktakeBadge(status?: string | null): {
  label: string;
  tone: "success" | "warning" | "danger" | "info" | "neutral";
} {
  switch (status) {
    case "posted":
      return { label: "posted", tone: "success" };
    case "approved":
      return { label: "approved", tone: "info" };
    case "counting":
    case "review":
      return { label: status, tone: "warning" };
    case "cancelled":
      return { label: "cancelled", tone: "danger" };
    default:
      return { label: status ?? "draft", tone: "neutral" };
  }
}