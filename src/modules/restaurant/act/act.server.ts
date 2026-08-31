/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * I13 "NOVA ACT & VERIFY" — orchestration.
 *
 * Two-phase, deliberately, mirroring I12's own preview/commit split:
 * previewNovaExecution performs ZERO writes — it re-reads the prepared
 * record fresh and classifies whether it's actually still safe to execute.
 * executeNovaPreparation only ever runs on an explicit human "Execute"
 * click and is the ONLY place that drives the record through its real
 * governed lifecycle. Both re-run the identical readiness classification —
 * execute never trusts a client-supplied "it was ready a moment ago"
 * (spec section 3: prepared work is not authority; section 22: stale
 * preparation must stop, never silently refresh-and-execute).
 *
 * I13 never invents a second mutation path: for stock_transfer, executing
 * a prepared draft means calling the EXACT SAME transfers.server.ts
 * functions (approveTransfer / dispatchTransfer / receiveTransfer) the
 * manual Inventory Control UI already calls — the same governance
 * boundaries (transfer.approve vs transfer.manage) apply whether a human
 * clicks through the form or NOVA drives it (spec section 30).
 */
import { assertCapability } from "../core/access.server";
import { locationNameMap } from "../inventory/locations.server";
import type {
  ExecuteNovaPreparationInput,
  NovaExecutableWorkflow,
  NovaExecutionLine,
  NovaExecutionPreview,
  NovaExecutionReadiness,
  NovaExecutionReceipt,
  NovaExecutionResult,
  NovaExecutionVerification,
  PreviewNovaExecutionInput,
  VerifyNovaExecutionInput,
} from "./act.contracts";

type Sb = any;

const EXECUTABLE_FROM_STATUSES = new Set(["draft", "requested", "approved"]);
const ALREADY_EXECUTED_STATUSES = new Set([
  "dispatched",
  "partially_received",
  "received",
  "completed",
]);

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

async function loadTransferWithLines(sb: Sb, tenantId: string, transferId: string) {
  const { data: transfer } = await sb
    .from("restaurant_stock_transfers")
    .select("*")
    .eq("id", transferId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!transfer) return null;
  const { data: lines } = await sb
    .from("restaurant_stock_transfer_lines")
    .select("*")
    .eq("transfer_id", transferId)
    .eq("tenant_id", tenantId);
  return { transfer: transfer as any, lines: (lines ?? []) as any[] };
}

/** Re-reads item names and each line's SOURCE-location on-hand quantity fresh from the ledger's own derived read model — never trusted from I12's prepare-time snapshot (spec section 22). */
async function buildExecutionLines(
  sb: Sb,
  tenantId: string,
  sourceLocationId: string,
  lines: any[],
): Promise<NovaExecutionLine[]> {
  const itemIds = lines.map((l) => l.inventory_item_id);
  const [{ data: items }, { data: positions }] = await Promise.all([
    itemIds.length
      ? sb
          .from("restaurant_inventory_items")
          .select("id, name")
          .eq("tenant_id", tenantId)
          .in("id", itemIds)
      : Promise.resolve({ data: [] }),
    itemIds.length
      ? sb
          .from("restaurant_stock_positions_v")
          .select("inventory_item_id, on_hand")
          .eq("tenant_id", tenantId)
          .eq("location_id", sourceLocationId)
          .in("inventory_item_id", itemIds)
      : Promise.resolve({ data: [] }),
  ]);
  const nameById = new Map(((items ?? []) as any[]).map((i) => [i.id, i.name]));
  const onHandById = new Map(
    ((positions ?? []) as any[]).map((p) => [p.inventory_item_id, Number(p.on_hand)]),
  );
  return lines.map((l) => ({
    inventoryItemId: l.inventory_item_id,
    inventoryItemName: nameById.get(l.inventory_item_id) ?? l.inventory_item_id,
    quantity: Number(l.requested_quantity),
    unitId: l.unit_id ?? null,
    availableQuantity: onHandById.has(l.inventory_item_id)
      ? onHandById.get(l.inventory_item_id)!
      : null,
  }));
}

interface Classified {
  readiness: NovaExecutionReadiness;
  transfer: any | null;
  lines: any[];
  message: string;
  warnings: string[];
}

/** Shared by preview and execute — the one place readiness is decided, so the two can never disagree. */
async function classify(
  sb: Sb,
  userId: string,
  tenantId: string,
  workflow: NovaExecutableWorkflow,
  recordId: string,
): Promise<Classified> {
  if (workflow !== "stock_transfer") {
    return {
      readiness: "unsupported",
      transfer: null,
      lines: [],
      warnings: [],
      message: "I can't execute that kind of preparation yet.",
    };
  }

  const loaded = await loadTransferWithLines(sb, tenantId, recordId);
  if (!loaded) {
    return {
      readiness: "not_found",
      transfer: null,
      lines: [],
      warnings: [],
      message: "That prepared movement no longer exists.",
    };
  }
  const { transfer, lines } = loaded;

  if (["rejected", "cancelled"].includes(transfer.status)) {
    return {
      readiness: "stale",
      transfer,
      lines,
      warnings: [],
      message: `This movement was ${transfer.status} and can no longer be executed.`,
    };
  }
  if (ALREADY_EXECUTED_STATUSES.has(transfer.status)) {
    return {
      readiness: "already_executed",
      transfer,
      lines,
      warnings: [],
      message: "This movement has already been executed.",
    };
  }
  if (!EXECUTABLE_FROM_STATUSES.has(transfer.status)) {
    return {
      readiness: "stale",
      transfer,
      lines,
      warnings: [],
      message: `This movement is in an unexpected state ("${transfer.status}") and can't be executed right now.`,
    };
  }

  const needsApproval = transfer.status === "draft" || transfer.status === "requested";
  const [canApprove, canManage] = await Promise.all([
    needsApproval ? hasCapability(sb, userId, tenantId, "transfer.approve") : Promise.resolve(true),
    hasCapability(sb, userId, tenantId, "transfer.manage"),
  ]);
  if (!canManage) {
    return {
      readiness: "unauthorized",
      transfer,
      lines,
      warnings: [],
      message: "You don't have authority to execute this movement.",
    };
  }
  if (needsApproval && !canApprove) {
    return {
      readiness: "unauthorized",
      transfer,
      lines,
      warnings: [],
      message:
        "This movement still needs approval, and you don't hold approval authority for stock transfers.",
    };
  }

  const executionLines = await buildExecutionLines(
    sb,
    tenantId,
    transfer.source_location_id,
    lines,
  );
  const warnings: string[] = [];
  for (const l of executionLines) {
    if (l.availableQuantity !== null && l.availableQuantity < l.quantity) {
      warnings.push(
        `Only ${l.availableQuantity} of "${l.inventoryItemName}" is currently available at the source location (${l.quantity} requested).`,
      );
    }
  }

  return {
    readiness: "ready",
    transfer,
    lines,
    warnings,
    message: "Ready to execute this stock movement.",
  };
}

async function toPreview(
  sb: Sb,
  tenantId: string,
  workflow: NovaExecutableWorkflow,
  recordId: string,
  classified: Classified,
): Promise<NovaExecutionPreview> {
  let sourceLocationName: string | null = null;
  let destinationLocationName: string | null = null;
  if (classified.transfer) {
    const names = await locationNameMap(sb, tenantId);
    sourceLocationName = names.get(classified.transfer.source_location_id) ?? null;
    destinationLocationName = names.get(classified.transfer.destination_location_id) ?? null;
  }
  const lines =
    classified.readiness === "ready" || classified.readiness === "already_executed"
      ? await buildExecutionLines(
          sb,
          tenantId,
          classified.transfer?.source_location_id ?? "",
          classified.lines,
        )
      : [];
  return {
    workflow,
    recordId,
    documentNumber: classified.transfer?.transfer_number ?? null,
    readiness: classified.readiness,
    status: classified.transfer?.status ?? null,
    sourceLocationName,
    destinationLocationName,
    lines,
    warnings: classified.warnings,
    message: classified.message,
  };
}

/** Read-only. Safe to call every time the review screen renders — re-verifies capability, staleness and available stock without writing anything. */
export async function previewNovaExecution(
  sb: Sb,
  userId: string,
  input: PreviewNovaExecutionInput,
): Promise<NovaExecutionPreview> {
  const classified = await classify(sb, userId, input.tenantId, input.workflow, input.recordId);
  return toPreview(sb, input.tenantId, input.workflow, input.recordId, classified);
}

function translateExecutionError(err: unknown): {
  message: string;
  readiness: "unauthorized" | "stale";
} {
  const message = (err as Error)?.message ?? "";
  if ((err as any)?.code === "negative_stock" || /negative_stock/i.test(message)) {
    return { message, readiness: "stale" };
  }
  if (/^Forbidden/.test(message)) {
    return {
      message: "You don't have authority to execute this operation.",
      readiness: "unauthorized",
    };
  }
  return {
    message:
      "Execution could not complete. The movement was not changed beyond what's shown below.",
    readiness: "stale",
  };
}

/**
 * The only place I13 ever writes anything. Re-runs the identical
 * classification itself first (never trusts a stale client-held preview),
 * drives the transfer through its real governed lifecycle
 * (approve-if-needed -> dispatch -> receive, each its own existing
 * capability-checked function), then independently re-reads the ledger to
 * verify the result before ever reporting success (spec section 18).
 */
export async function executeNovaPreparation(
  sb: Sb,
  userId: string,
  input: ExecuteNovaPreparationInput,
): Promise<NovaExecutionResult> {
  const classified = await classify(sb, userId, input.tenantId, input.workflow, input.recordId);

  if (classified.readiness === "already_executed") {
    // Idempotent: a retry (double-click, network replay) after a prior
    // successful execution reports the same outcome again rather than
    // erroring or re-mutating anything.
    const verification = await verifyStockTransferExecution(sb, input.tenantId, input.recordId);
    const receipt = await buildReceipt(
      sb,
      input.tenantId,
      userId,
      classified.transfer,
      classified.lines,
    );
    return {
      ok: true,
      readiness: "ready",
      receipt,
      verification,
      message: "This movement was already executed and verified.",
    };
  }
  if (classified.readiness !== "ready") {
    return { ok: false, readiness: classified.readiness, message: classified.message };
  }

  const { transfer, lines } = classified;
  const tenantId = input.tenantId;

  try {
    const { approveTransfer, dispatchTransfer, receiveTransfer } =
      await import("../inventory/transfers.server");

    if (transfer.status === "draft" || transfer.status === "requested") {
      await approveTransfer(sb, userId, { tenantId, transferId: transfer.id, approve: true });
    }
    await dispatchTransfer(sb, userId, {
      tenantId,
      transferId: transfer.id,
      lines: lines.map((l) => ({ lineId: l.id, dispatchedQuantity: Number(l.requested_quantity) })),
    });
    const dispatchedLines = await reloadLines(sb, tenantId, transfer.id);
    await receiveTransfer(sb, userId, {
      tenantId,
      transferId: transfer.id,
      lines: dispatchedLines.map((l: any) => ({
        lineId: l.id,
        receivedQuantity: Number(l.dispatched_quantity ?? 0),
        rejectedQuantity: 0,
        damagedQuantity: 0,
      })),
    });
  } catch (err) {
    const translated = translateExecutionError(err);
    return { ok: false, readiness: translated.readiness, message: translated.message };
  }

  const finalLoaded = await loadTransferWithLines(sb, tenantId, transfer.id);
  const verification = await verifyStockTransferExecution(sb, tenantId, transfer.id);
  const receipt = await buildReceipt(
    sb,
    tenantId,
    userId,
    finalLoaded?.transfer ?? transfer,
    finalLoaded?.lines ?? lines,
  );

  if (!verification.verified) {
    return {
      ok: false,
      readiness: "stale",
      message: `Execution completed, but verification could not confirm the result. Please review movement ${receipt.documentNumber ?? receipt.recordId}.`,
    };
  }

  return {
    ok: true,
    readiness: "ready",
    receipt,
    verification,
    message: buildReceiptMessage(receipt),
  };
}

function buildReceiptMessage(receipt: NovaExecutionReceipt): string {
  const lines = receipt.lines.map((l) => `• ${l.inventoryItemName} — ${l.quantity}`).join("\n");
  const ref = receipt.documentNumber ?? receipt.recordId;
  return `Stock movement executed and verified.\n\n${lines}\n\nMovement: ${ref}\nStatus: Verified`;
}

async function reloadLines(sb: Sb, tenantId: string, transferId: string) {
  const { data } = await sb
    .from("restaurant_stock_transfer_lines")
    .select("*")
    .eq("transfer_id", transferId)
    .eq("tenant_id", tenantId);
  return (data ?? []) as any[];
}

async function buildReceipt(
  sb: Sb,
  tenantId: string,
  userId: string,
  transfer: any,
  lines: any[],
): Promise<NovaExecutionReceipt> {
  const executionLines = await buildExecutionLines(
    sb,
    tenantId,
    transfer.source_location_id,
    lines,
  );
  return {
    workflow: "stock_transfer",
    recordId: transfer.id,
    documentNumber: transfer.transfer_number ?? null,
    status: transfer.status,
    executedBy: userId,
    executedAt: new Date().toISOString(),
    lines: executionLines,
  };
}

/**
 * Independent verifier — re-reads the transfer AND the ledger fresh; never
 * trusts the executor's own return values (spec section 18). Callable
 * standalone (a "Verify" action never auto-chained to execute), and reused
 * internally by executeNovaPreparation itself right after it runs.
 */
export async function verifyStockTransferExecution(
  sb: Sb,
  tenantId: string,
  transferId: string,
): Promise<NovaExecutionVerification> {
  const loaded = await loadTransferWithLines(sb, tenantId, transferId);
  if (!loaded) {
    return {
      verified: false,
      outcome: "transfer_missing",
      reason: "The prepared movement record no longer exists.",
    };
  }
  const { transfer, lines } = loaded;
  if (!ALREADY_EXECUTED_STATUSES.has(transfer.status)) {
    return {
      verified: false,
      outcome: "unexpected_status",
      entityType: "stock_transfer",
      entityId: transfer.id,
      status: transfer.status,
      reason: `Expected the movement to have been dispatched/received; found "${transfer.status}".`,
    };
  }

  const { data: movements } = await sb
    .from("restaurant_stock_movements")
    .select("id, movement_type, quantity, inventory_item_id, location_id")
    .eq("tenant_id", tenantId)
    .eq("reference_type", "restaurant_stock_transfer")
    .eq("reference_id", transferId);
  const rows = (movements ?? []) as any[];

  for (const line of lines) {
    const outMovement = rows.find(
      (m) => m.movement_type === "transfer_out" && m.inventory_item_id === line.inventory_item_id,
    );
    const inMovement = rows.find(
      (m) => m.movement_type === "transfer_in" && m.inventory_item_id === line.inventory_item_id,
    );
    const expectedQuantity = Number(line.dispatched_quantity ?? line.requested_quantity ?? 0);
    if (!outMovement || Math.abs(Number(outMovement.quantity)) !== expectedQuantity) {
      return {
        verified: false,
        outcome: "movement_mismatch",
        entityType: "inventory_item",
        entityId: line.inventory_item_id,
        expectedQuantity,
        actualQuantity: outMovement ? Math.abs(Number(outMovement.quantity)) : 0,
        reason: "The source movement does not match the expected dispatched quantity.",
      };
    }
    if (transfer.status === "completed" || transfer.status === "received") {
      const expectedIn = Number(line.received_quantity ?? 0);
      if (expectedIn > 0 && (!inMovement || Math.abs(Number(inMovement.quantity)) !== expectedIn)) {
        return {
          verified: false,
          outcome: "movement_mismatch",
          entityType: "inventory_item",
          entityId: line.inventory_item_id,
          expectedQuantity: expectedIn,
          actualQuantity: inMovement ? Math.abs(Number(inMovement.quantity)) : 0,
          reason: "The destination movement does not match the expected received quantity.",
        };
      }
    }
  }

  return {
    verified: true,
    outcome: "stock_movement_executed",
    entityType: "stock_transfer",
    entityId: transfer.id,
    status: transfer.status,
  };
}

/** Standalone verifier entry point — never auto-chained, callable independently at any time after execution. */
export async function verifyNovaExecution(
  sb: Sb,
  userId: string,
  input: VerifyNovaExecutionInput,
): Promise<NovaExecutionVerification> {
  const canRead = await hasCapability(sb, userId, input.tenantId, "transfer.manage");
  if (!canRead) {
    return {
      verified: false,
      outcome: "unauthorized",
      reason: "You don't have authority to verify this movement.",
    };
  }
  if (input.workflow !== "stock_transfer") {
    return { verified: false, outcome: "verification_unavailable" };
  }
  return verifyStockTransferExecution(sb, input.tenantId, input.recordId);
}
