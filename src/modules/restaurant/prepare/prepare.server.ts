/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * I12 "NOVA PREPARE" — orchestration.
 *
 * Two-phase, deliberately: previewNovaPreparation is called automatically
 * alongside every I11 understanding (see staffnova.server.ts) and performs
 * ZERO writes — it only classifies readiness from independently
 * re-verified data. commitNovaPreparation only ever runs on an explicit
 * human button click (see StaffNovaPanel.tsx) and is the ONLY place any of
 * the three real, already-proven-safe draft-creation functions
 * (savePurchaseRequest / createTransfer / saveRequisitionDraft) is called.
 * Both re-run the identical readiness classification — commit never
 * trusts a client-supplied "it was ready a moment ago".
 *
 * I12 never calls anything from purchasing.server.ts (PO creation/
 * transition), movements.server.ts (instant ledger post), or any
 * approval/issue/dispatch/receive function — see the I12 architectural
 * verdict for the full audit this boundary is built on.
 */
import { assertCapability } from "../core/access.server";
import type {
  NovaAction,
  NovaEntityMention,
  NovaIntentContract,
  NovaLocationReference,
} from "../understand/intent.contracts";
import { APPROVAL_CAPABILITY_REGISTRY, WORKFLOW_REGISTRY } from "./registry";
import {
  resolveTenantCurrency,
  verifyInventoryItem,
  verifyLocation,
  verifySupplier,
  verifyUnit,
} from "./resolve.server";
import type {
  CommitNovaPreparationInput,
  NovaPreparation,
  NovaPreparationFields,
  NovaPreparationLine,
  NovaPreparationReadiness,
  NovaPreparationWorkflow,
  NovaPurchaseRequestFields,
  NovaRequisitionFields,
  NovaStockTransferFields,
  PreviewNovaPreparationInput,
} from "./prepare.contracts";

type Sb = any;

async function hasCapability(
  sb: Sb,
  userId: string,
  tenantId: string,
  capability: string,
): Promise<boolean> {
  try {
    await assertCapability(sb, userId, tenantId, capability as any);
    return true;
  } catch {
    return false;
  }
}

function emptyPreparation(
  action: NovaAction,
  readiness: NovaPreparationReadiness,
  message: string,
): NovaPreparation {
  return {
    workflow: null,
    action,
    readiness,
    fields: null,
    missingFields: [],
    ambiguousFields: [],
    warnings: [],
    createdRecordId: null,
    documentNumber: null,
    message,
  };
}

interface ResolvedLine {
  raw: string;
  inventoryItemId: string | null;
  inventoryItemName: string | null;
  quantity: number | null;
  unitId: string | null;
  unitText: string | null;
  ambiguous: boolean;
}

async function resolveEntityLine(
  sb: Sb,
  tenantId: string,
  entity: NovaEntityMention,
): Promise<ResolvedLine> {
  let inventoryItemId: string | null = null;
  let inventoryItemName: string | null = null;
  const ambiguous = entity.status === "ambiguous";

  if (!ambiguous && (entity.status === "exact" || entity.status === "high") && entity.resolvedId) {
    const row = await verifyInventoryItem(sb, tenantId, entity.resolvedId);
    if (row) {
      inventoryItemId = row.id;
      inventoryItemName = row.name;
    }
  }

  let unitId: string | null = null;
  if (entity.quantity?.resolvedUnitId) {
    const unitRow = await verifyUnit(sb, tenantId, entity.quantity.resolvedUnitId);
    if (unitRow) unitId = unitRow.id;
  }

  return {
    raw: entity.raw,
    inventoryItemId,
    inventoryItemName,
    quantity: entity.quantity?.quantity ?? null,
    unitId,
    unitText: entity.quantity?.unitText ?? null,
    ambiguous,
  };
}

function toPreparationLine(l: ResolvedLine): NovaPreparationLine {
  return {
    raw: l.raw,
    inventoryItemId: l.inventoryItemId,
    inventoryItemName: l.inventoryItemName,
    description: l.inventoryItemName ?? l.raw,
    quantity: l.quantity,
    unitId: l.unitId,
    unitText: l.unitText,
  };
}

interface ResolvedLocation {
  status: "resolved" | "ambiguous" | "missing";
  id: string | null;
  name: string | null;
  locationType: string | null;
}

async function resolveLocationRef(
  sb: Sb,
  tenantId: string,
  ref: NovaLocationReference | null,
): Promise<ResolvedLocation> {
  const missing: ResolvedLocation = { status: "missing", id: null, name: null, locationType: null };
  if (!ref) return missing;
  if (ref.status === "ambiguous")
    return { status: "ambiguous", id: null, name: null, locationType: null };
  if ((ref.status !== "exact" && ref.status !== "high") || !ref.resolvedId) return missing;
  const row = await verifyLocation(sb, tenantId, ref.resolvedId);
  if (!row) return missing;
  return { status: "resolved", id: row.id, name: row.name, locationType: row.locationType };
}

/** kitchen/bar/department requisition "kind" is required by the schema but never produced by I11 — derived deterministically from the destination location's own real location_type, never guessed from free text. */
function requisitionKindFor(locationType: string | null): "kitchen" | "bar" | "department" {
  if (locationType === "kitchen") return "kitchen";
  if (locationType === "bar") return "bar";
  return "department";
}

function pickReadiness(
  ambiguousFields: string[],
  missingFields: string[],
  warnings: string[],
): NovaPreparationReadiness {
  if (ambiguousFields.length > 0) return "ambiguous";
  if (missingFields.length > 0) return "missing_required_information";
  if (warnings.length > 0) return "ready_with_warnings";
  return "ready";
}

function buildMessage(
  workflow: NovaPreparationWorkflow,
  readiness: NovaPreparationReadiness,
  missingFields: string[],
  ambiguousFields: string[],
): string {
  const label =
    workflow === "purchase_request"
      ? "purchase request"
      : workflow === "stock_transfer"
        ? "stock transfer"
        : "requisition";
  switch (readiness) {
    case "ready":
      return `Ready to prepare this ${label}.`;
    case "ready_with_warnings":
      return `Ready to prepare this ${label} — please review the notes below first.`;
    case "ambiguous":
      return `I need clarification before I can prepare this ${label}: ${ambiguousFields.join("; ")}.`;
    case "missing_required_information":
      return `I need a bit more information before I can prepare this ${label}: ${missingFields.join("; ")}.`;
    default:
      return `I can't prepare this ${label} right now.`;
  }
}

/**
 * Classifies readiness and independently re-verifies every id — but never
 * writes anything. Safe to call on every assistant turn.
 */
export async function previewNovaPreparation(
  sb: Sb,
  userId: string,
  input: PreviewNovaPreparationInput,
): Promise<NovaPreparation> {
  const { tenantId, contract } = input;
  const action = contract.action;

  const approvalCapability = APPROVAL_CAPABILITY_REGISTRY[action];
  if (approvalCapability) {
    const authorized = await hasCapability(sb, userId, tenantId, approvalCapability);
    if (!authorized) {
      return emptyPreparation(
        action,
        "unauthorized",
        "You don't have permission to do that here — this stays with whoever holds purchase-order approval authority.",
      );
    }
    return emptyPreparation(
      action,
      "missing_required_information",
      "I understand you want to act on a purchase order, but I don't have a specific order identified yet — please open it directly from the Purchasing page.",
    );
  }

  const entry = WORKFLOW_REGISTRY[action];
  if (!entry) {
    return emptyPreparation(
      action,
      "unsupported",
      "I don't have a way to prepare that kind of request yet.",
    );
  }

  const authorized = await hasCapability(sb, userId, tenantId, entry.prepareCapability);
  if (!authorized) {
    return {
      ...emptyPreparation(action, "unauthorized", "You don't have permission to prepare this."),
      workflow: entry.workflow,
    };
  }

  const resolvedLines = await Promise.all(
    contract.entities.map((e) => resolveEntityLine(sb, tenantId, e)),
  );

  const ambiguousFields: string[] = [];
  const missingFields: string[] = [];
  const warnings: string[] = [];

  if (resolvedLines.length === 0) {
    missingFields.push("at least one item");
  }

  resolvedLines.forEach((l, i) => {
    if (l.ambiguous) {
      ambiguousFields.push(`item ${i + 1} ("${l.raw}")`);
      return;
    }
    if (l.quantity === null) missingFields.push(`quantity for "${l.raw}"`);
    if (entry.workflow === "purchase_request") {
      if (!l.inventoryItemId)
        warnings.push(
          `"${l.raw}" wasn't found in the catalogue — added as free text; please verify it in the form.`,
        );
    } else if (!l.inventoryItemId) {
      missingFields.push(`could not identify "${l.raw}" in the catalogue`);
    }
    if (l.quantity !== null && l.unitText && !l.unitId) {
      warnings.push(
        `"${l.unitText}" isn't a recognized unit for this catalogue — please choose a valid unit in the form.`,
      );
    }
  });

  let sourceLoc: ResolvedLocation | null = null;
  let destLoc: ResolvedLocation | null = null;
  if (entry.workflow !== "purchase_request") {
    sourceLoc = await resolveLocationRef(sb, tenantId, contract.locations.source);
    destLoc = await resolveLocationRef(sb, tenantId, contract.locations.destination);
    if (sourceLoc.status === "ambiguous") ambiguousFields.push("source location");
    else if (sourceLoc.status === "missing") missingFields.push("source location");
    if (destLoc.status === "ambiguous") ambiguousFields.push("destination location");
    else if (destLoc.status === "missing") missingFields.push("destination location");
  }

  let supplierId: string | null = null;
  let supplierName: string | null = null;
  if (entry.workflow === "purchase_request" && contract.supplier) {
    if (contract.supplier.status === "ambiguous") {
      ambiguousFields.push("supplier");
    } else if (
      (contract.supplier.status === "exact" || contract.supplier.status === "high") &&
      contract.supplier.resolvedId
    ) {
      const row = await verifySupplier(sb, tenantId, contract.supplier.resolvedId);
      if (row) {
        supplierId = row.id;
        supplierName = row.name;
      }
    } else if (contract.supplier.kind === "cheapest") {
      warnings.push(
        "You asked for the cheapest supplier — NOVA doesn't rank suppliers here; please choose one in the form.",
      );
    } else if (contract.supplier.status === "unresolved") {
      warnings.push(
        `Supplier "${contract.supplier.raw}" wasn't found — please choose one in the form.`,
      );
    }
  }

  const readiness = pickReadiness(ambiguousFields, missingFields, warnings);
  const lines = resolvedLines.map(toPreparationLine);

  let fields: NovaPreparationFields = null;
  if (entry.workflow === "purchase_request") {
    fields = {
      supplierId,
      supplierName,
      lines: lines.map((l) => ({ ...l, estimatedUnitCost: 0 })),
    } as NovaPurchaseRequestFields;
  } else if (entry.workflow === "stock_transfer") {
    fields = {
      sourceLocationId: sourceLoc?.id ?? null,
      sourceLocationName: sourceLoc?.name ?? null,
      destinationLocationId: destLoc?.id ?? null,
      destinationLocationName: destLoc?.name ?? null,
      lines,
    } as NovaStockTransferFields;
  } else {
    fields = {
      sourceLocationId: sourceLoc?.id ?? null,
      sourceLocationName: sourceLoc?.name ?? null,
      destinationLocationId: destLoc?.id ?? null,
      destinationLocationName: destLoc?.name ?? null,
      kind: requisitionKindFor(destLoc?.locationType ?? null),
      lines,
    } as NovaRequisitionFields;
  }

  return {
    workflow: entry.workflow,
    action,
    readiness,
    fields,
    missingFields,
    ambiguousFields,
    warnings,
    createdRecordId: null,
    documentNumber: null,
    message: buildMessage(entry.workflow, readiness, missingFields, ambiguousFields),
  };
}

/**
 * The only place I12 ever writes anything. Re-runs previewNovaPreparation
 * itself first — a caller can never skip straight to a write with stale or
 * client-asserted readiness — and only proceeds to create a real draft row
 * when the fresh readiness is "ready" or "ready_with_warnings".
 */
export async function commitNovaPreparation(
  sb: Sb,
  userId: string,
  input: CommitNovaPreparationInput,
): Promise<NovaPreparation> {
  const preview = await previewNovaPreparation(sb, userId, input);
  if (preview.readiness !== "ready" && preview.readiness !== "ready_with_warnings") {
    return preview;
  }

  const { tenantId } = input;

  if (preview.workflow === "purchase_request") {
    const fields = preview.fields as NovaPurchaseRequestFields;
    const currency = await resolveTenantCurrency(sb, tenantId);
    const { savePurchaseRequest } = await import("../procurement/requests.server");
    const result = await savePurchaseRequest(sb, userId, {
      tenantId,
      priority: "normal",
      currency,
      reason: "Prepared by NOVA from a staff request.",
      lines: fields.lines.map((l) => ({
        inventoryItemId: l.inventoryItemId ?? undefined,
        unitId: l.unitId ?? undefined,
        preferredSupplierId: fields.supplierId ?? undefined,
        description: l.description,
        quantity: l.quantity ?? 0,
        estimatedUnitCost: l.estimatedUnitCost,
      })),
    });
    return { ...preview, createdRecordId: result.id, documentNumber: result.documentNumber };
  }

  if (preview.workflow === "stock_transfer") {
    const fields = preview.fields as NovaStockTransferFields;
    const { createTransfer } = await import("../inventory/transfers.server");
    const result = await createTransfer(sb, userId, {
      tenantId,
      sourceLocationId: fields.sourceLocationId!,
      destinationLocationId: fields.destinationLocationId!,
      requiresApproval: false,
      submit: false,
      notes: "Prepared by NOVA from a staff request.",
      lines: fields.lines.map((l) => ({
        inventoryItemId: l.inventoryItemId!,
        unitId: l.unitId ?? undefined,
        requestedQuantity: l.quantity!,
      })),
    });
    return { ...preview, createdRecordId: result.id, documentNumber: result.transferNumber };
  }

  if (preview.workflow === "requisition") {
    const fields = preview.fields as NovaRequisitionFields;
    const { saveRequisitionDraft } = await import("../requisitions/requisitions.server");
    const result = await saveRequisitionDraft(sb, userId, {
      tenantId,
      kind: fields.kind,
      sourceLocationId: fields.sourceLocationId!,
      destinationLocationId: fields.destinationLocationId!,
      submit: false,
      notes: "Prepared by NOVA from a staff request.",
      lines: fields.lines.map((l) => ({
        inventoryItemId: l.inventoryItemId!,
        unitId: l.unitId ?? undefined,
        requestedQuantity: l.quantity!,
      })),
    });
    return { ...preview, createdRecordId: result.id, documentNumber: result.reference };
  }

  return preview;
}

export type { NovaIntentContract };
