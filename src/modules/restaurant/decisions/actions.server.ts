/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Phase 5 / P10 — Act and Verify.
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
 *
 * Lifecycle (P10): proposed -> approved -> queued -> executing -> executed
 * -> verified, with failure edges queued/executing -> failed and
 * executed -> verification_failed. `executeRestaurantAction` drives the
 * chain up to "executed"; `verifyRestaurantAction` is a distinct,
 * subsequent call that re-reads the real database consequence and decides
 * "verified" vs "verification_failed" — Act and Verify are never fused into
 * one call, so an action is never treated as confirmed before someone has
 * checked the actual downstream record. Rows written before P10 under the
 * old two-state vocabulary ('completed') are read as a synonym for
 * "executed" — nothing writes 'completed' going forward.
 */
import { getTenantScopeChecker } from "@/modules/intelligence/core/registry";
import { assertCapability } from "../core/access.server";
import { nextDocumentNumber, recordProcurementAudit } from "../procurement/audit.server";
import { DOCUMENT_PREFIX } from "../procurement/contracts";
import { emitActionEvent } from "./actionEvents.server";

type Sb = any;

/** The only action type this executor knows how to run. */
const SUPPORTED_ACTION_TYPES = new Set(["restaurant.purchase.suggest"]);

/** A row in one of these states already ran to completion — never re-executed. */
const ALREADY_EXECUTED_STATUSES = new Set([
  "executed",
  "completed",
  "verified",
  "verification_failed",
]);
/** Statuses execution may legitimately resume from. */
const RESUMABLE_STATUSES = new Set(["approved", "queued", "executing", "failed"]);
/** Statuses verification may run against — anything that finished executing. */
const VERIFIABLE_STATUSES = new Set(["executed", "completed", "verified", "verification_failed"]);

const now = () => new Date().toISOString();

export interface ExecuteRestaurantActionResult {
  actionId: string;
  status: "executed" | "failed" | "completed";
  executionResult?: "procurement_request_created";
  procurementRequestId?: string;
  procurementRequestStatus?: string;
  failureReason?: string;
  /** True when a prior run already produced this result — nothing new happened. */
  alreadyExecuted?: boolean;
}

export interface VerifyRestaurantActionResult {
  verified: boolean;
  outcome: string;
  entityType?: string;
  entityId?: string;
  expectedQuantity?: number;
  actualQuantity?: number;
  status?: string;
  reason?: string;
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

async function loadActionAndDecision(sb: Sb, actionId: string) {
  const { data: action, error: actionErr } = await sb
    .from("intelligence_actions")
    .select(
      "id, decision_id, module, action_type, status, result, queued_at, executing_at, completed_at, verified_at, verification_result",
    )
    .eq("id", actionId)
    .single();
  if (actionErr || !action) throw new Error("Action not found.");

  const { data: decision, error: decisionErr } = await sb
    .from("intelligence_decisions")
    .select("id, tenant_id, module, decision_key, property_id, location_id, context")
    .eq("id", action.decision_id)
    .single();
  if (decisionErr || !decision) throw new Error("Owning decision not found.");

  return { action, decision };
}

/**
 * Optimistic, status-guarded transition: only succeeds if the row is still
 * in `fromStatus` at write time. Returns the winning caller's fresh view of
 * the row, or `null` if another worker already moved it — the practical,
 * existing-architecture concurrency guard the task asks for, with no new
 * job queue: two callers racing `executeRestaurantAction` on the same
 * action can only ever have one of them actually perform each transition.
 */
async function guardedTransition(
  sb: Sb,
  actionId: string,
  fromStatus: string,
  patch: Record<string, unknown>,
): Promise<Record<string, any> | null> {
  const { data, error } = await sb
    .from("intelligence_actions")
    .update(patch)
    .eq("id", actionId)
    .eq("status", fromStatus)
    .select(
      "id, decision_id, module, action_type, status, result, queued_at, executing_at, completed_at, verified_at, verification_result",
    )
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function failAction(
  sb: Sb,
  userId: string,
  action: Record<string, any>,
  tenantId: string,
  module: string,
  reason: string,
): Promise<ExecuteRestaurantActionResult> {
  await sb
    .from("intelligence_actions")
    .update({ status: "failed", failed_at: now(), failure_reason: reason })
    .eq("id", action.id);
  await emitActionEvent(sb, userId, {
    type: "intelligence.action.failed",
    tenantId,
    module,
    actionId: action.id,
    decisionId: action.decision_id,
    payload: { reason },
  });
  return { actionId: action.id, status: "failed", failureReason: reason };
}

/**
 * Executes exactly one intelligence action, driving it from "approved" (or
 * a resumable in-flight/failed state) through "queued" -> "executing" ->
 * "executed".
 *
 * Idempotent in three layers:
 *  - an already-executed action (new "executed"/legacy "completed", or a
 *    later "verified"/"verification_failed") with a recorded
 *    `procurement_request_id` is returned unchanged, never re-executed;
 *  - if a previous attempt created the procurement request but crashed
 *    before the action could be marked executed (a genuine partial
 *    failure), the request is recovered by `correlation_id = action.id`
 *    instead of creating a second one;
 *  - every status transition is optimistically guarded (`eq("status", ...)`
 *    plus a `select` to see whether the write actually matched), so two
 *    concurrent callers can never both perform the same transition or both
 *    create the procurement request.
 */
export async function executeRestaurantAction(
  sb: Sb,
  userId: string,
  input: { actionId: string },
): Promise<ExecuteRestaurantActionResult> {
  const { action: initialAction, decision } = await loadActionAndDecision(sb, input.actionId);
  let action = initialAction;

  if (action.module !== "restaurant") {
    throw new Error(`No executor registered for module "${action.module}".`);
  }
  if (!SUPPORTED_ACTION_TYPES.has(action.action_type)) {
    throw new Error(`No executor registered for action type "${action.action_type}".`);
  }

  // Fails closed via the same registry I2 built and I3 reused — no bespoke
  // authorization path for this executor.
  await assertActionScope(sb, userId, decision.module, decision.tenant_id);
  const tenantId = decision.tenant_id as string;
  const module = decision.module as string;

  if (ALREADY_EXECUTED_STATUSES.has(action.status) && action.result?.procurement_request_id) {
    return {
      actionId: action.id,
      status: action.status === "completed" ? "completed" : "executed",
      executionResult: "procurement_request_created",
      procurementRequestId: action.result.procurement_request_id,
      procurementRequestStatus: action.result.procurement_request_status ?? "draft",
      alreadyExecuted: true,
    };
  }
  if (!RESUMABLE_STATUSES.has(action.status)) {
    throw new Error(
      `Action ${action.id} is "${action.status}" — only an approved action can be executed.`,
    );
  }

  // Advance approved/failed -> queued -> executing, guarded against a
  // concurrent competitor at every step. Bounded so a persistently
  // inconsistent row (which should never happen against a real database)
  // cannot spin forever.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (action.status === "approved" || action.status === "failed") {
      const won = await guardedTransition(sb, action.id, action.status, {
        status: "queued",
        queued_at: now(),
        failure_reason: null,
      });
      if (won) {
        action = won;
        await emitActionEvent(sb, userId, {
          type: "intelligence.action.queued",
          tenantId,
          module,
          actionId: action.id,
          decisionId: decision.id,
        });
        continue;
      }
      // Lost the race — another caller moved it first. Re-read and follow
      // whatever state it's genuinely in rather than proceeding blind.
      ({ action } = await loadActionAndDecision(sb, input.actionId));
      continue;
    }

    if (action.status === "queued") {
      const won = await guardedTransition(sb, action.id, "queued", {
        status: "executing",
        executing_at: now(),
      });
      if (won) {
        action = won;
        await emitActionEvent(sb, userId, {
          type: "intelligence.action.executing",
          tenantId,
          module,
          actionId: action.id,
          decisionId: decision.id,
        });
        continue;
      }
      ({ action } = await loadActionAndDecision(sb, input.actionId));
      continue;
    }

    if (action.status === "executing") {
      return runPurchaseSuggestExecution(sb, userId, action, decision, tenantId, module);
    }

    // Already executed by the competitor that won the race above.
    if (ALREADY_EXECUTED_STATUSES.has(action.status) && action.result?.procurement_request_id) {
      return {
        actionId: action.id,
        status: action.status === "completed" ? "completed" : "executed",
        executionResult: "procurement_request_created",
        procurementRequestId: action.result.procurement_request_id,
        procurementRequestStatus: action.result.procurement_request_status ?? "draft",
        alreadyExecuted: true,
      };
    }

    throw new Error(`Unexpected action status "${action.status}" mid-execution.`);
  }
  throw new Error(
    `Action ${action.id} did not converge to "executing" — too much write contention.`,
  );
}

/** The one governed effect this executor performs, run once the action is "executing". */
async function runPurchaseSuggestExecution(
  sb: Sb,
  userId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
  tenantId: string,
  module: string,
): Promise<ExecuteRestaurantActionResult> {
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
      userId,
      action,
      tenantId,
      module,
      "The owning decision has no structured purchasing data (inventory item / quantity) — cannot build a procurement request line.",
    );
  }
  if (typeof supplierId !== "string") {
    return failAction(
      sb,
      userId,
      action,
      tenantId,
      module,
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
    return failAction(sb, userId, action, tenantId, module, correlationErr.message);
  }

  let requestId: string;
  let requestStatus: string;

  if (existingByCorrelation) {
    requestId = existingByCorrelation.id;
    requestStatus = existingByCorrelation.status;
  } else {
    try {
      await assertCapability(sb, userId, tenantId, "purchase.request");
    } catch (err) {
      return failAction(sb, userId, action, tenantId, module, (err as Error).message);
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
    if (createErr) {
      // Another concurrent execution of this exact action won the race and
      // already inserted the (tenant_id, correlation_id)-unique row — the
      // same "already happened, not an error" pattern movements.server.ts's
      // insertMovement uses for its own dedupe key. Recover the winner's
      // request instead of failing or duplicating.
      if (String((createErr as any).code) === "23505") {
        const { data: recovered, error: recoverErr } = await sb
          .from("restaurant_purchase_requests")
          .select("id, status")
          .eq("tenant_id", tenantId)
          .eq("correlation_id", action.id)
          .maybeSingle();
        if (recoverErr || !recovered) {
          return failAction(
            sb,
            userId,
            action,
            tenantId,
            module,
            recoverErr?.message ??
              "Concurrent insert detected but the winning request could not be recovered.",
          );
        }
        requestId = recovered.id as string;
        requestStatus = recovered.status as string;
        return finishExecution(
          sb,
          userId,
          action,
          decision,
          tenantId,
          module,
          requestId,
          requestStatus,
        );
      }
      return failAction(sb, userId, action, tenantId, module, createErr.message);
    }
    if (!created) {
      return failAction(
        sb,
        userId,
        action,
        tenantId,
        module,
        "Failed to create the procurement request.",
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
      return failAction(sb, userId, action, tenantId, module, lineErr.message);
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

  return finishExecution(sb, userId, action, decision, tenantId, module, requestId, requestStatus);
}

/** Marks the action "executed" once its procurement request exists (fresh or recovered). */
async function finishExecution(
  sb: Sb,
  userId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
  tenantId: string,
  module: string,
  requestId: string,
  requestStatus: string,
): Promise<ExecuteRestaurantActionResult> {
  await sb
    .from("intelligence_actions")
    .update({
      status: "executed",
      completed_at: now(),
      result: { procurement_request_id: requestId, procurement_request_status: requestStatus },
    })
    .eq("id", action.id);

  await emitActionEvent(sb, userId, {
    type: "intelligence.action.executed",
    tenantId,
    module,
    actionId: action.id,
    decisionId: decision.id,
    payload: { procurement_request_id: requestId },
  });

  return {
    actionId: action.id,
    status: "executed",
    executionResult: "procurement_request_created",
    procurementRequestId: requestId,
    procurementRequestStatus: requestStatus,
  };
}

type Verifier = (
  sb: Sb,
  tenantId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
) => Promise<VerifyRestaurantActionResult>;

/**
 * Only the action type that actually has an executor gets a real verifier.
 * Every other type in the restaurant provider's `handles` list — and any
 * type this module doesn't own at all — returns "verification_unavailable"
 * rather than being reported as verified.
 */
const VERIFIERS: Record<string, Verifier> = {
  "restaurant.purchase.suggest": verifyPurchaseSuggest,
};

/**
 * Re-reads the real downstream record an executed action was supposed to
 * produce and confirms — or positively refutes — that it happened as
 * described. Every value in the result comes from a fresh database read;
 * nothing here is fabricated from the action's own cached `result`.
 *
 * A distinct call from `executeRestaurantAction`: Act ends at "executed",
 * Verify is the separate confirmation step that moves the action to
 * "verified" or "verification_failed".
 */
export async function verifyRestaurantAction(
  sb: Sb,
  userId: string,
  input: { actionId: string },
): Promise<VerifyRestaurantActionResult> {
  const { action, decision } = await loadActionAndDecision(sb, input.actionId);

  if (action.module !== "restaurant") {
    throw new Error(`No executor registered for module "${action.module}".`);
  }

  await assertActionScope(sb, userId, decision.module, decision.tenant_id);
  const tenantId = decision.tenant_id as string;
  const module = decision.module as string;

  const verifier = VERIFIERS[action.action_type];
  if (!verifier) {
    return {
      verified: false,
      outcome: "verification_unavailable",
      reason: `No verifier implemented for action type "${action.action_type}".`,
    };
  }

  if (!VERIFIABLE_STATUSES.has(action.status)) {
    return {
      verified: false,
      outcome: "not_executed",
      reason: `Action is "${action.status}" — cannot verify an action that has not executed.`,
    };
  }

  const result = await verifier(sb, tenantId, action, decision);

  await sb
    .from("intelligence_actions")
    .update({
      status: result.verified ? "verified" : "verification_failed",
      verified_at: now(),
      verification_result: result,
    })
    .eq("id", action.id);

  await emitActionEvent(sb, userId, {
    type: result.verified
      ? "intelligence.action.verified"
      : "intelligence.action.verification_failed",
    tenantId,
    module,
    actionId: action.id,
    decisionId: decision.id,
    payload: result as unknown as Record<string, unknown>,
  });

  return result;
}

/**
 * The seven checks P10 requires: the request exists, belongs to the same
 * tenant, is linked to this action via `correlation_id`, carries the
 * expected item and quantity, remains in the expected governed ("draft")
 * state, and is not duplicated.
 */
async function verifyPurchaseSuggest(
  sb: Sb,
  tenantId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
): Promise<VerifyRestaurantActionResult> {
  const facts = (decision.context?.finding?.facts ?? {}) as Record<string, unknown>;
  const expectedQuantity =
    typeof facts.recommendedQuantity === "number" ? facts.recommendedQuantity : undefined;
  const expectedItemId =
    typeof facts.inventoryItemId === "string" ? facts.inventoryItemId : undefined;

  const expectedRequestId = action.result?.procurement_request_id as string | undefined;
  if (!expectedRequestId) {
    return {
      verified: false,
      outcome: "purchase_request_missing",
      reason: "The action has no recorded procurement_request_id to verify.",
    };
  }

  const { data: request, error } = await sb
    .from("restaurant_purchase_requests")
    .select("id, tenant_id, correlation_id, status")
    .eq("id", expectedRequestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!request) {
    return {
      verified: false,
      outcome: "purchase_request_missing",
      entityType: "purchase_request",
      entityId: expectedRequestId,
      reason: `Purchase request ${expectedRequestId} does not exist.`,
    };
  }
  if (request.tenant_id !== tenantId) {
    return {
      verified: false,
      outcome: "tenant_mismatch",
      entityType: "purchase_request",
      entityId: request.id,
      reason: "The purchase request belongs to a different tenant.",
    };
  }
  if (request.correlation_id !== action.id) {
    return {
      verified: false,
      outcome: "correlation_mismatch",
      entityType: "purchase_request",
      entityId: request.id,
      reason: "The purchase request's correlation_id does not match this action.",
    };
  }

  const { data: items, error: itemsErr } = await sb
    .from("restaurant_purchase_request_items")
    .select("id, inventory_item_id, quantity")
    .eq("purchase_request_id", request.id);
  if (itemsErr) throw new Error(itemsErr.message);
  const rows = (items ?? []) as Array<{ inventory_item_id: string | null; quantity: number }>;
  const matchingItem = expectedItemId
    ? rows.find((r) => r.inventory_item_id === expectedItemId)
    : rows[0];

  if (!matchingItem) {
    return {
      verified: false,
      outcome: "item_missing",
      entityType: "purchase_request",
      entityId: request.id,
      reason: `Expected inventory item ${expectedItemId ?? "(unknown)"} was not found on the purchase request.`,
    };
  }

  const actualQuantity = Number(matchingItem.quantity);
  if (expectedQuantity != null && actualQuantity !== expectedQuantity) {
    return {
      verified: false,
      outcome: "quantity_mismatch",
      entityType: "purchase_request",
      entityId: request.id,
      expectedQuantity,
      actualQuantity,
      reason: `Expected quantity ${expectedQuantity}, found ${actualQuantity}.`,
    };
  }

  if (request.status !== "draft") {
    return {
      verified: false,
      outcome: "unexpected_status",
      entityType: "purchase_request",
      entityId: request.id,
      status: request.status,
      reason: `Expected the request to remain "draft" (governed, unsubmitted); found "${request.status}".`,
    };
  }

  const { data: dupes, error: dupErr } = await sb
    .from("restaurant_purchase_requests")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("correlation_id", action.id);
  if (dupErr) throw new Error(dupErr.message);
  const dupeCount = (dupes ?? []).length;
  if (dupeCount > 1) {
    return {
      verified: false,
      outcome: "duplicate_request",
      entityType: "purchase_request",
      entityId: request.id,
      reason: `Found ${dupeCount} purchase requests correlated to this action — expected exactly 1.`,
    };
  }

  return {
    verified: true,
    outcome: "purchase_request_created",
    entityType: "purchase_request",
    entityId: request.id,
    expectedQuantity,
    actualQuantity,
    status: request.status,
  };
}
