/**
 * I12 "NOVA PREPARE" — contracts.
 *
 * NovaPreparation is understanding-turned-into-a-real-but-safe-draft: it
 * names which EXISTING workflow a validated NovaIntentContract maps to,
 * whether it's actually ready to prepare, and (once committed) the id of
 * the real draft row created in that workflow's own table. It never
 * represents an executed/submitted/approved operation — see
 * prepare.server.ts for the two-phase preview/commit split that keeps it
 * that way.
 */
import { z } from "zod";
import { novaIntentContractSchema, type NovaAction } from "../understand/intent.contracts";

/** Every existing workflow I12 is allowed to prepare — see the I12 architectural verdict for why these three and not others (pricing/kitchen have no safe, prefillable entry point yet). */
export const NOVA_PREPARATION_WORKFLOWS = [
  "purchase_request",
  "stock_transfer",
  "requisition",
] as const;
export type NovaPreparationWorkflow = (typeof NOVA_PREPARATION_WORKFLOWS)[number];

export const NOVA_PREPARATION_READINESS = [
  "ready",
  "ready_with_warnings",
  "missing_required_information",
  "ambiguous",
  "unauthorized",
  "unsupported",
] as const;
export type NovaPreparationReadiness = (typeof NOVA_PREPARATION_READINESS)[number];

export interface NovaPreparationLine {
  raw: string;
  inventoryItemId: string | null;
  inventoryItemName: string | null;
  description: string;
  quantity: number | null;
  unitId: string | null;
  unitText: string | null;
}

export interface NovaPurchaseRequestFields {
  supplierId: string | null;
  supplierName: string | null;
  lines: Array<NovaPreparationLine & { estimatedUnitCost: number }>;
}

export interface NovaStockTransferFields {
  sourceLocationId: string | null;
  sourceLocationName: string | null;
  destinationLocationId: string | null;
  destinationLocationName: string | null;
  lines: NovaPreparationLine[];
}

export interface NovaRequisitionFields extends NovaStockTransferFields {
  kind: "kitchen" | "bar" | "department";
}

export type NovaPreparationFields =
  NovaPurchaseRequestFields | NovaStockTransferFields | NovaRequisitionFields | null;

/**
 * The full preparation outcome. `createdRecordId`/`documentNumber` are
 * only ever set by commitNovaPreparation, and only after a real draft row
 * has actually been inserted — previewNovaPreparation always returns them
 * as null, since it performs no writes at all.
 */
export interface NovaPreparation {
  workflow: NovaPreparationWorkflow | null;
  action: NovaAction;
  readiness: NovaPreparationReadiness;
  fields: NovaPreparationFields;
  missingFields: string[];
  ambiguousFields: string[];
  warnings: string[];
  createdRecordId: string | null;
  documentNumber: string | null;
  message: string;
}

export const previewNovaPreparationSchema = z.object({
  tenantId: z.string().uuid(),
  contract: novaIntentContractSchema,
});
export type PreviewNovaPreparationInput = z.infer<typeof previewNovaPreparationSchema>;

/** Identical shape to preview — commit always re-runs the same preview logic itself (defense in depth) before ever writing anything. */
export const commitNovaPreparationSchema = previewNovaPreparationSchema;
export type CommitNovaPreparationInput = z.infer<typeof commitNovaPreparationSchema>;
