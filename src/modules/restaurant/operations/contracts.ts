/**
 * Phase 2 — service operations contracts (shifts, waste, daily close).
 * Contract-only in Phase 1.
 */
import { z } from "zod";

export const shiftCloseSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid(),
  shiftDate: z.string(),
  shift: z.enum(["breakfast", "lunch", "dinner", "late", "all_day"]),
  covers: z.number().int().min(0).default(0),
  netSales: z.number().min(0).default(0),
  notes: z.string().max(2000).optional(),
});

export const wasteRecordSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  inventoryItemId: z.string().uuid(),
  quantity: z.number().min(0),
  unitId: z.string().uuid().optional(),
  reason: z.enum(["spoilage", "breakage", "over_production", "staff_meal", "comp", "other"]),
  cost: z.number().min(0).default(0),
  notes: z.string().max(1000).optional(),
});