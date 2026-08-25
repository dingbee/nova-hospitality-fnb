/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Phase 5 — the first Act-stage executor.
 *
 * Turns an approved `intelligence_actions` row into the one governed effect
 * it is allowed to have: a draft purchase request in the existing
 * `restaurant_purchase_requests` procurement workflow. It never purchases,
 * never contacts a supplier, never touches inventory, and never bypasses
 * approval — the request it creates is a `draft`, exactly the state a staff
 * member creating one by hand would leave it in, still requiring submission
 * and a separate human approval before it can become a purchase order.
 *
 * Only `decideDecision` (Intelligence Core governance, I2/I3) creates an
 * action, and only for a decision a restaurant tenant member has already
 * approved. This executor performs the action that approval authorized — it
 * does not, itself, decide or approve anything.
 */
import { getTenantScopeChecker } from "@/modules/intelligence/core/registry";
import { assertCapability } from "../core/access.server";
import { nextDocumentNumber, recordProcurementAudit } from "../procurement/audit.server";
import { DOCUMENT_PREFIX } from "../procurement/contracts";

type Sb = any;

/** The only action type this executor knows how to run. */
const SUPPORTED_ACTION_TYPES = new Set(["restaurant.purchase.suggest"]);

export interface ExecuteRestaurantActionResult {
  actionId: string;
  status: "completed" | "failed";
  executionResult?: "procurement_request_created";
  procurementRequestId?: string;
  procurementRequestStatus?: string;
  failureReason?: string;
  /** True when a prior run already produced this result — nothing new happened. */
  alreadyExecuted?: boolean;
}

/** Mirrors decision.server.ts's assertDecisionScope / events.server.ts's assertEventScope. */
async function assertActionScope(
  sb: Sb,
  userId: string,
  module: string,
  tenantId: string,
): Promise<void> {
  const checker = getTenantScopeChecker(module as any);
  if (!checker) {
    throw new Error(
      `No tenant scope authorization is registered for module "${module}" — refusing to execute this action.`,
    );
  }
  await checker(sb, userId, { tenantId });
}

async function failAction(
  sb: Sb,
  actionId: string,
  reason: string,
): Promise<ExecuteRestaurantActionResult> {
  await sb
    .from("intelligence_actions")
    .update({ status: "failed", failed_at: new Date().toISOString(), failure_reason: reason })
    .eq("id", actionId);
  return { actionId, status: "failed", failureReason: reason };
}

/**
 * Executes exactly one intelligence action.
 *
 * Idempotent in two layers:
 *  - a `completed` action with a recorded `procurement_request_id` is
 *    returned unchanged, never re-executed;
 *  - if a previous attempt created the procurement request but crashed
 *    before the action could be marked complete (a genuine partial
 *    failure), the request is recovered by `correlation_id = action.id`
 *    instead of creating a second one.
 */
export async function executeRestaurantAction(
  sb: Sb,
  userId: string,
  input: { actionId: string },
): Promise<ExecuteRestaurantActionResult> {
  const { data: action, error: actionErr } = await sb
    .from("intelligence_actions")
    .select("id, decision_id, module, action_type, status, result")
    .eq("id", input.actionId)
    .single();
  if (actionErr || !action) throw new Error("Action not found.");

  if (action.module !== "restaurant") {
    throw new Error(`No executor registered for module "${action.module}".`);
  }
  if (!SUPPORTED_ACTION_TYPES.has(action.action_type)) {
    throw new Error(`No executor registered for action type "${action.action_type}".`);
  }

  const { data: decision, error: decisionErr } = await sb
    .from("intelligence_decisions")
    .select("id, tenant_id, module, decision_key, property_id, location_id, context")
    .eq("id", action.decision_id)
    .single();
  if (decisionErr || !decision) throw new Error("Owning decision not found.");

  // Fails closed via the same registry I2 built and I3 reused — no bespoke
  // authorization path for this executor.
  await assertActionScope(sb, userId, decision.module, decision.tenant_id);

  if (action.status === "completed" && action.result?.procurement_request_id) {
    return {
      actionId: action.id,
      status: "completed",
      executionResult: "procurement_request_created",
      procurementRequestId: action.result.procurement_request_id,
      procurementRequestStatus: action.result.procurement_request_status ?? "draft",
      alreadyExecuted: true,
    };
  }
  // "executing" and "failed" are both re-enterable so a retry after a crash
  // or a previously captured failure can proceed; every other status means
  // the governance step that authorizes execution never happened.
  if (!["approved", "executing", "failed"].includes(action.status)) {
    throw new Error(
      `Action ${action.id} is "${action.status}" — only an approved action can be executed.`,
    );
  }

  const tenantId = decision.tenant_id as string;
  const finding = (decision.context?.finding ?? {}) as {
    subject?: string;
    headline?: string;
    facts?: Record<string, unknown>;
  };
  const facts = finding.facts ?? {};
  const inventoryItemId = facts.inventoryItemId;
  const recommendedQuantity = facts.recommendedQuantity;
  const supplierId = facts.supplierId;
  const estimatedUnitCost = facts.estimatedUnitCost;
  const estimatedCost = facts.estimatedCost;
  const currency = typeof facts.currency === "string" ? facts.currency : "TZS";

  if (
    typeof inventoryItemId !== "string" ||
    typeof recommendedQuantity !== "number" ||
    recommendedQuantity <= 0
  ) {
    return failAction(
      sb,
      action.id,
      "The owning decision has no structured purchasing data (inventory item / quantity) — cannot build a procurement request line.",
    );
  }
  if (typeof supplierId !== "string") {
    return failAction(
      sb,
      action.id,
      "No supplier product on file for this item — a procurement draft cannot be created until a supplier price is added.",
    );
  }

  const { data: existingByCorrelation, error: correlationErr } = await sb
    .from("restaurant_purchase_requests")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("correlation_id", action.id)
    .maybeSingle();
  if (correlationErr) {
    return failAction(sb, action.id, correlationErr.message);
  }

  await sb
    .from("intelligence_actions")
    .update({ status: "executing", executing_at: new Date().toISOString() })
    .eq("id", action.id)
    .eq("status", action.status);

  let requestId: string;
  let requestStatus: string;

  if (existingByCorrelation) {
    requestId = existingByCorrelation.id;
    requestStatus = existingByCorrelation.status;
  } else {
    try {
      await assertCapability(sb, userId, tenantId, "purchase.request");
    } catch (err) {
      return failAction(sb, action.id, (err as Error).message);
    }

    const unitCost =
      typeof estimatedUnitCost === "number" && estimatedUnitCost > 0
        ? estimatedUnitCost
        : typeof estimatedCost === "number"
          ? estimatedCost / recommendedQuantity
          : 0;
    const estimatedTotal = recommendedQuantity * unitCost;

    const documentNumber = await nextDocumentNumber(
      sb,
      tenantId,
      "purchase_request",
      DOCUMENT_PREFIX.purchase_request,
    );

    const { data: created, error: createErr } = await sb
      .from("restaurant_purchase_requests")
      .insert({
        tenant_id: tenantId,
        property_id: decision.property_id ?? null,
        location_id: decision.location_id ?? null,
        document_number: documentNumber,
        status: "draft",
        priority: "normal",
        category: "intelligence",
        reason: decision.decision_key,
        notes:
          `Raised automatically from a governed intelligence decision (${decision.decision_key}). ` +
          "Requires review, submission and approval like any other purchase request.",
        currency,
        estimated_total: estimatedTotal,
        requested_by: userId,
        correlation_id: action.id,
        metadata: {
          source: "intelligence",
          decision_id: decision.id,
          action_id: action.id,
          decision_key: decision.decision_key,
        },
      })
      .select("id")
      .single();
    if (createErr || !created) {
      return failAction(
        sb,
        action.id,
        createErr?.message ?? "Failed to create the procurement request.",
      );
    }
    requestId = created.id as string;
    requestStatus = "draft";

    const { error: lineErr } = await sb.from("restaurant_purchase_request_items").insert({
      tenant_id: tenantId,
      purchase_request_id: requestId,
      inventory_item_id: inventoryItemId,
      preferred_supplier_id: supplierId,
      description: finding.subject ?? "Replenishment",
      quantity: recommendedQuantity,
      estimated_unit_cost: unitCost,
      estimated_total: estimatedTotal,
      justification: finding.headline ?? null,
      recommendation_ref: decision.decision_key,
    });
    if (lineErr) {
      return failAction(sb, action.id, lineErr.message);
    }

    await recordProcurementAudit(sb, userId, {
      tenantId,
      documentType: "purchase_request",
      documentId: requestId,
      documentNumber,
      action: "created",
      newState: "draft",
      metadata: { origin: "intelligence", decision_id: decision.id, action_id: action.id },
    });
  }

  await sb
    .from("intelligence_actions")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      result: { procurement_request_id: requestId, procurement_request_status: requestStatus },
    })
    .eq("id", action.id);

  return {
    actionId: action.id,
    status: "completed",
    executionResult: "procurement_request_created",
    procurementRequestId: requestId,
    procurementRequestStatus: requestStatus,
  };
}
