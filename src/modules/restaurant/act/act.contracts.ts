/**
 * I13 "NOVA ACT & VERIFY" — contracts.
 *
 * An I12 NovaPreparation names a real (draft-status) row. I13 turns that
 * into a real operational effect by driving it through the SAME governed
 * lifecycle functions a human would click through by hand — never a new
 * mutation path. Only workflows listed in NOVA_EXECUTABLE_WORKFLOWS can be
 * executed; everything else fails closed with readiness "unsupported" (see
 * the I13 architectural verdict, section 8, for why only stock_transfer is
 * in scope this pass).
 */
import { z } from "zod";
import type { NovaPreparationWorkflow } from "../prepare/prepare.contracts";

/** Every workflow I13 is allowed to execute. Adding one here is exactly the boundary between "I13 can execute this" and "I13 has never heard of this" — see registry.ts's EXECUTE_REGISTRY, which must also carry an entry. */
export const NOVA_EXECUTABLE_WORKFLOWS = ["stock_transfer"] as const;
export type NovaExecutableWorkflow = (typeof NOVA_EXECUTABLE_WORKFLOWS)[number];

export const NOVA_EXECUTION_READINESS = [
  "ready",
  "already_executed",
  "stale",
  "unauthorized",
  "unsupported",
  "not_found",
] as const;
export type NovaExecutionReadiness = (typeof NOVA_EXECUTION_READINESS)[number];

export interface NovaExecutionLine {
  inventoryItemId: string;
  inventoryItemName: string;
  quantity: number;
  unitId: string | null;
  /** The source location's current on-hand quantity for this item, re-read fresh — null when it could not be determined. Never trusted from I12's prepare-time snapshot. */
  availableQuantity: number | null;
}

/**
 * What NOVA shows before asking for the explicit "Execute" confirmation —
 * read-only, re-verifies everything, never writes. Mirrors I12's preview
 * shape deliberately (same readiness-classification split as
 * previewNovaPreparation/commitNovaPreparation).
 */
export interface NovaExecutionPreview {
  workflow: NovaExecutableWorkflow;
  recordId: string;
  documentNumber: string | null;
  readiness: NovaExecutionReadiness;
  status: string | null;
  sourceLocationName: string | null;
  destinationLocationName: string | null;
  lines: NovaExecutionLine[];
  warnings: string[];
  message: string;
}

export interface NovaExecutionVerification {
  verified: boolean;
  outcome: string;
  entityType?: string;
  entityId?: string;
  expectedQuantity?: number;
  actualQuantity?: number;
  status?: string;
  reason?: string;
}

export interface NovaExecutionReceipt {
  workflow: NovaExecutableWorkflow;
  recordId: string;
  documentNumber: string | null;
  status: string;
  executedBy: string;
  executedAt: string;
  lines: NovaExecutionLine[];
}

/**
 * executeNovaPreparation's result. Always reports what actually happened —
 * never claims success the independent verification step didn't confirm
 * (spec section 19: verify failure must never be reported as success).
 */
export type NovaExecutionResult =
  | {
      ok: true;
      readiness: "ready";
      receipt: NovaExecutionReceipt;
      verification: NovaExecutionVerification;
      message: string;
    }
  | {
      ok: false;
      readiness: Exclude<NovaExecutionReadiness, "ready">;
      message: string;
    };

/** Deliberately takes only the already-committed record's identity — never a re-parsed chat instruction or a client-asserted payload. Section 3: "prepared work is not authority" — everything else is re-derived server-side from this id alone. */
export const previewNovaExecutionSchema = z.object({
  tenantId: z.string().uuid(),
  workflow: z.enum(NOVA_EXECUTABLE_WORKFLOWS),
  recordId: z.string().uuid(),
});
export type PreviewNovaExecutionInput = z.infer<typeof previewNovaExecutionSchema>;

/** Identical shape to preview — execute always re-runs the same preview logic itself (defense in depth) before ever mutating anything. */
export const executeNovaPreparationSchema = previewNovaExecutionSchema;
export type ExecuteNovaPreparationInput = z.infer<typeof executeNovaPreparationSchema>;

export const verifyNovaExecutionSchema = previewNovaExecutionSchema;
export type VerifyNovaExecutionInput = z.infer<typeof verifyNovaExecutionSchema>;

export type { NovaPreparationWorkflow };
