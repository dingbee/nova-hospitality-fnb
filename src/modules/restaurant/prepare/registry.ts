/**
 * I12 — the intent-action -> existing-workflow mapping. Pure, no I/O.
 *
 * Only actions with a proven, safe, zero-ledger-effect draft-creation path
 * exist here (see the I12 architectural verdict, points 2-3). Adding an
 * entry here is exactly the boundary between "I12 can prepare this" and
 * "I12 has never heard of this" — nothing outside this table is ever
 * prepared, however plausible-sounding an action name is.
 */
import type { NovaAction } from "../understand/intent.contracts";
import type { RestaurantCapability } from "../core/permissions";
import type { NovaPreparationWorkflow } from "./prepare.contracts";

export interface WorkflowRegistryEntry {
  workflow: NovaPreparationWorkflow;
  /** The capability required to PREPARE this workflow — deliberately the same broad, low-friction capability the existing "raise a draft" entry point already requires, never the higher execution-side capability (see spec section 16: preparation authority and execution authority may differ). */
  prepareCapability: RestaurantCapability;
}

export const WORKFLOW_REGISTRY: Partial<Record<NovaAction, WorkflowRegistryEntry>> = {
  prepare_purchase_order: { workflow: "purchase_request", prepareCapability: "purchase.request" },
  prepare_stock_movement: { workflow: "stock_transfer", prepareCapability: "transfer.manage" },
  execute_stock_movement: { workflow: "stock_transfer", prepareCapability: "transfer.manage" },
  prepare_requisition: { workflow: "requisition", prepareCapability: "requisition.create" },
};

/**
 * "Approve the PO" / "Submit the PO" are recognized and authority-checked
 * against the REAL transition's own capability — but never prepared: I12
 * has no draft/prepare concept for an approval, and I11 never resolves a
 * specific PO reference from text in this sprint, so these always end in
 * either "unauthorized" or "missing_required_information", never "ready".
 */
export const APPROVAL_CAPABILITY_REGISTRY: Partial<Record<NovaAction, RestaurantCapability>> = {
  approve_purchase_order: "purchasing.approve",
  submit_purchase_order: "purchasing.manage",
};
