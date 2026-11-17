/**
 * Inventory Control RPC surface (Sprint 5.2).
 *
 * Thin wrappers only: every handler validates with a Zod contract, then defers
 * to a server-only service. Capability and tenant checks live in the services,
 * so no caller can reach stock by choosing a different entry point.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  approveTransferSchema,
  cancelTransferSchema,
  createReservationSchema,
  createTransferSchema,
  dispatchTransferSchema,
  inventoryOverviewSchema,
  listBatchesSchema,
  listLocationsSchema,
  listReasonsSchema,
  listReservationsSchema,
  listStocktakesSchema,
  listTransfersSchema,
  postStocktakeSchema,
  receiveTransferSchema,
  reconciliationSchema,
  recordAdjustmentSchema,
  recordWasteSchema,
  releaseReservationSchema,
  reverseMovementSchema,
  saveStocktakeCountsSchema,
  startStocktakeSchema,
  stockPositionsSchema,
  upsertBatchSchema,
  upsertLocationSchema,
  upsertReasonSchema,
} from "./contracts";

const tenantAndId = z.object({ tenantId: z.string().uuid(), id: z.string().uuid() });

/* ---------------- Locations ---------------- */

export const listInventoryLocationsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listLocationsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./locations.server");
    return mod.listLocations(context.supabase, context.userId, data);
  });

export const upsertInventoryLocationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertLocationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./locations.server");
    return mod.upsertLocation(context.supabase, context.userId, data);
  });

/* ---------------- Positions ---------------- */

export const listStockPositionsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => stockPositionsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./positions.server");
    return mod.listStockPositions(context.supabase, context.userId, data);
  });

export const getStockItemDetailFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tenantAndId.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./positions.server");
    return mod.getItemDetail(context.supabase, context.userId, data.tenantId, data.id);
  });

/* ---------------- Transfers ---------------- */

export const listStockTransfersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listTransfersSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./transfers.server");
    return mod.listTransfers(context.supabase, context.userId, data);
  });

export const getStockTransferFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tenantAndId.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./transfers.server");
    return mod.getTransfer(context.supabase, context.userId, data.tenantId, data.id);
  });

export const createStockTransferFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createTransferSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./transfers.server");
    return mod.createTransfer(context.supabase, context.userId, data);
  });

export const approveStockTransferFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => approveTransferSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./transfers.server");
    return mod.approveTransfer(context.supabase, context.userId, data);
  });

export const dispatchStockTransferFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => dispatchTransferSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./transfers.server");
    return mod.dispatchTransfer(context.supabase, context.userId, data);
  });

export const receiveStockTransferFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => receiveTransferSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./transfers.server");
    return mod.receiveTransfer(context.supabase, context.userId, data);
  });

export const cancelStockTransferFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelTransferSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./transfers.server");
    return mod.cancelTransfer(context.supabase, context.userId, data);
  });

/* ---------------- Waste, adjustments, reasons ---------------- */

export const listInventoryReasonsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listReasonsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./waste.server");
    return mod.listReasons(context.supabase, context.userId, data);
  });

export const upsertInventoryReasonFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertReasonSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./waste.server");
    return mod.upsertReason(context.supabase, context.userId, data);
  });

export const recordInventoryWasteFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordWasteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./waste.server");
    return mod.recordWaste(context.supabase, context.userId, data);
  });

export const recordInventoryAdjustmentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordAdjustmentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./waste.server");
    return mod.recordAdjustment(context.supabase, context.userId, data);
  });

export const reverseStockMovementFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => reverseMovementSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./waste.server");
    return mod.reverseMovement(context.supabase, context.userId, data);
  });

/* ---------------- Reservations ---------------- */

export const listStockReservationsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listReservationsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reservations.server");
    return mod.listReservations(context.supabase, context.userId, data);
  });

export const createStockReservationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createReservationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reservations.server");
    return mod.createReservation(context.supabase, context.userId, data);
  });

export const releaseStockReservationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => releaseReservationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./reservations.server");
    return mod.releaseReservation(context.supabase, context.userId, data);
  });

/* ---------------- Stocktake ---------------- */

export const listStocktakesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listStocktakesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./stocktake.server");
    return mod.listStocktakes(context.supabase, context.userId, data);
  });

export const getStocktakeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => tenantAndId.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./stocktake.server");
    return mod.getStocktake(context.supabase, context.userId, data.tenantId, data.id);
  });

export const startStocktakeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => startStocktakeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./stocktake.server");
    return mod.startStocktake(context.supabase, context.userId, data);
  });

export const saveStocktakeCountsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => saveStocktakeCountsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./stocktake.server");
    return mod.saveStocktakeCounts(context.supabase, context.userId, data);
  });

export const postStocktakeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => postStocktakeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./stocktake.server");
    return mod.postStocktake(context.supabase, context.userId, data);
  });

/* ---------------- Batches ---------------- */

export const listInventoryBatchesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listBatchesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./batches.server");
    return mod.listBatches(context.supabase, context.userId, data);
  });

export const upsertInventoryBatchFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertBatchSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./batches.server");
    return mod.upsertBatch(context.supabase, context.userId, data);
  });

/* ---------------- Overview & reconciliation ---------------- */

export const getInventoryOverviewFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => inventoryOverviewSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./overview.server");
    return mod.getInventoryOverview(context.supabase, context.userId, data);
  });

export const listInventoryReconciliationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => reconciliationSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./overview.server");
    return mod.listReconciliation(context.supabase, context.userId, data);
  });