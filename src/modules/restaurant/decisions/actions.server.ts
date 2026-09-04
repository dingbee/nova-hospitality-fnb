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
 * Two action types share this one procurement-draft effect and one code
 * path — I5 added `restaurant.inventory.replenish_review` alongside the
 * original `restaurant.purchase.suggest` rather than building a second
 * executor, because both mean the same thing operationally ("raise a
 * governed replenishment draft for this item/quantity/supplier") and both
 * read the identical fact shape (`inventoryItemId`/`recommendedQuantity`/
 * `supplierId`/...) off `decision.context.finding.facts`. The inventory
 * option catalogue (optionCatalogue.ts's shortageOptions) already offered
 * `restaurant.inventory.replenish_review` before I5 — this file is what
 * makes that option actually executable, rather than a dead action type.
 *
 * I6 adds a third, differently-shaped action type:
 * `restaurant.menu.reprice_review`. Its governed effect is not a
 * procurement draft — it is a `pending_approval` row in the existing,
 * already-built `restaurant_prices` version/approval workflow
 * (pricing.server.ts's `upsertPrice`/`decidePrice`). That table already
 * separates "propose a price" (capability `pricing.manage`) from "publish
 * a price" (capability `pricing.approve`, a distinct, higher-privilege
 * check) — exactly the governed, capability-protected path the task asked
 * this executor to find and reuse rather than inventing pricing autonomy.
 * This executor only ever proposes; it never calls `decidePrice`, so a
 * live selling price never changes as a direct or indirect effect of
 * Intelligence approving a decision. See `runMenuRepriceExecution` and
 * `verifyMenuRepriceReview` below.
 *
 * I8 adds a fourth action type, `restaurant.kitchen.staffing_review`, and
 * reuses I7's `restaurant_operational_reviews` table rather than a new one
 * — the finding that proposes it is the exact same `kitchen_capacity`
 * finding I7 reads, differing only in which option a human approved
 * (`add_staff` vs `adjust_workflow`/`reallocate_stations`). The system has
 * no shift/schedule/attendance/payroll data (only `restaurant_members` role
 * assignments), so this executor never claims a staffing conclusion beyond
 * the same workload evidence (tickets/delayed%/over-target%/prep minutes)
 * I7 already reads — it records the engine's own recommendation text
 * verbatim, never inventing a headcount or an HR claim. See
 * `runKitchenStaffingReviewExecution` and `verifyKitchenStaffingReview`.
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
import { roundTo } from "../pricing/decimal";
import { audit as recordPricingAudit } from "../pricing/pricing.server";
import { emitActionEvent } from "./actionEvents.server";

type Sb = any;

/** The action types this executor knows how to run (see file doc comment for what each one does). */
const SUPPORTED_ACTION_TYPES = new Set([
  "restaurant.purchase.suggest",
  "restaurant.inventory.replenish_review",
  "restaurant.menu.reprice_review",
  "restaurant.kitchen.workflow_review",
  "restaurant.kitchen.staffing_review",
]);

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
  executionResult?:
    | "procurement_request_created"
    | "price_review_created"
    | "workflow_review_created"
    | "staffing_review_created";
  procurementRequestId?: string;
  procurementRequestStatus?: string;
  /** I6 — the restaurant_prices row id/status for a reprice_review action. Status is always "pending_approval" here; this executor never publishes a price. */
  priceReviewId?: string;
  priceReviewStatus?: string;
  /** I7 — the restaurant_operational_reviews row id/status for a kitchen.workflow_review action. Status is always "pending_review" here; this executor never touches operational kitchen state. */
  workflowReviewId?: string;
  workflowReviewStatus?: string;
  /** I8 — the restaurant_operational_reviews row id/status for a kitchen.staffing_review action. Same table/status as I7's workflow review; distinguished only by review_type = "kitchen_staffing". */
  staffingReviewId?: string;
  staffingReviewStatus?: string;
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
  /** I6 — money fields for a reprice_review verification, kept distinct from the quantity fields above rather than overloading them. */
  expectedAmount?: number;
  actualAmount?: number;
  status?: string;
  reason?: string;
}

/** Mirrors decision.server.ts's assertDecisionScope / events.server.ts's assertEventScope. */
async function assertActionScope(
  sb: Sb,
  userId: string,
  module: string,
  tenantId: string,
  propertyId?: string | null,
  locationId?: string | null,
): Promise<void> {
  const checker = getTenantScopeChecker(module as any);
  if (!checker) {
    throw new Error(
      `No tenant scope authorization is registered for module "${module}" — refusing to execute this action.`,
    );
  }
  await checker(sb, userId, { tenantId, propertyId, locationId });
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
    .select(
      "id, tenant_id, module, decision_key, property_id, location_id, context, options, recommended_option_key",
    )
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

/**
 * Reconstructs the result of a prior successful run from `action.result`
 * alone, without touching the database again — recognizes whichever of the
 * two governed effects this module can produce (a procurement draft or a
 * pricing review). Returns `null` if `action.result` doesn't carry either
 * shape yet, meaning there is nothing to recover and real execution must
 * still happen.
 */
function alreadyExecutedResult(action: Record<string, any>): ExecuteRestaurantActionResult | null {
  const status: ExecuteRestaurantActionResult["status"] =
    action.status === "completed" ? "completed" : "executed";
  if (action.result?.procurement_request_id) {
    return {
      actionId: action.id,
      status,
      executionResult: "procurement_request_created",
      procurementRequestId: action.result.procurement_request_id,
      procurementRequestStatus: action.result.procurement_request_status ?? "draft",
      alreadyExecuted: true,
    };
  }
  if (action.result?.price_review_id) {
    return {
      actionId: action.id,
      status,
      executionResult: "price_review_created",
      priceReviewId: action.result.price_review_id,
      priceReviewStatus: action.result.price_review_status ?? "pending_approval",
      alreadyExecuted: true,
    };
  }
  if (action.result?.workflow_review_id) {
    return {
      actionId: action.id,
      status,
      executionResult: "workflow_review_created",
      workflowReviewId: action.result.workflow_review_id,
      workflowReviewStatus: action.result.workflow_review_status ?? "pending_review",
      alreadyExecuted: true,
    };
  }
  if (action.result?.staffing_review_id) {
    return {
      actionId: action.id,
      status,
      executionResult: "staffing_review_created",
      staffingReviewId: action.result.staffing_review_id,
      staffingReviewStatus: action.result.staffing_review_status ?? "pending_review",
      alreadyExecuted: true,
    };
  }
  return null;
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
  await assertActionScope(
    sb,
    userId,
    decision.module,
    decision.tenant_id,
    decision.property_id ?? null,
    decision.location_id ?? null,
  );
  const tenantId = decision.tenant_id as string;
  const module = decision.module as string;

  if (ALREADY_EXECUTED_STATUSES.has(action.status)) {
    const already = alreadyExecutedResult(action);
    if (already) return already;
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
      if (action.action_type === "restaurant.menu.reprice_review") {
        return runMenuRepriceExecution(sb, userId, action, decision, tenantId, module);
      }
      if (action.action_type === "restaurant.kitchen.workflow_review") {
        return runKitchenWorkflowReviewExecution(sb, userId, action, decision, tenantId, module);
      }
      if (action.action_type === "restaurant.kitchen.staffing_review") {
        return runKitchenStaffingReviewExecution(sb, userId, action, decision, tenantId, module);
      }
      return runProcurementDraftExecution(sb, userId, action, decision, tenantId, module);
    }

    // Already executed by the competitor that won the race above.
    if (ALREADY_EXECUTED_STATUSES.has(action.status)) {
      const already = alreadyExecutedResult(action);
      if (already) return already;
    }

    throw new Error(`Unexpected action status "${action.status}" mid-execution.`);
  }
  throw new Error(
    `Action ${action.id} did not converge to "executing" — too much write contention.`,
  );
}

/**
 * The one governed effect this executor performs, run once the action is
 * "executing" — shared by both `restaurant.purchase.suggest` and
 * `restaurant.inventory.replenish_review` (see file doc comment). Nothing
 * below branches on `action.action_type`: the two types differ only in the
 * option/finding that proposed them, never in what executing one does.
 */
async function runProcurementDraftExecution(
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

/**
 * I6 — the governed effect for `restaurant.menu.reprice_review`: a
 * `pending_approval` row in the existing `restaurant_prices` workflow
 * (mirrors `upsertPrice(..., requiresApproval: true, activate: false)`
 * without importing the human-facing function itself, the same way
 * `runProcurementDraftExecution` writes `restaurant_purchase_requests`
 * directly rather than calling the staff CRUD entry point). It never
 * inserts an `active` row and never calls `decidePrice` — a live selling
 * price changes only when a separate human with `pricing.approve`
 * (distinct from the `pricing.manage` this executor itself requires)
 * reviews and approves it through the existing pricing UI.
 */
async function runMenuRepriceExecution(
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
  const menuItemId = facts.menuItemId;
  const recommendedPrice = facts.recommendedPrice;
  const capturedCurrentPrice = facts.currentPrice;
  const currency = typeof facts.currency === "string" ? facts.currency : null;

  if (
    typeof menuItemId !== "string" ||
    typeof recommendedPrice !== "number" ||
    !(recommendedPrice > 0) ||
    typeof currency !== "string"
  ) {
    return failAction(
      sb,
      userId,
      action,
      tenantId,
      module,
      "The owning decision has no structured pricing data (menu item / recommended price / currency) — cannot raise a pricing review.",
    );
  }
  if (typeof capturedCurrentPrice !== "number") {
    return failAction(
      sb,
      userId,
      action,
      tenantId,
      module,
      "The owning decision has no captured current price to validate freshness against — cannot raise a pricing review.",
    );
  }

  // Idempotency first, before any capability or freshness check, so a retry
  // of an already-completed action never re-runs (and never re-fails) those
  // checks against data that may have moved on since.
  const { data: existingByCorrelation, error: correlationErr } = await sb
    .from("restaurant_prices")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("correlation_id", action.id)
    .maybeSingle();
  if (correlationErr) {
    return failAction(sb, userId, action, tenantId, module, correlationErr.message);
  }
  if (existingByCorrelation) {
    return finishMenuRepriceExecution(
      sb,
      userId,
      action,
      decision,
      tenantId,
      module,
      existingByCorrelation.id,
      existingByCorrelation.status,
    );
  }

  // Intelligence-decision approval is not pricing authority: the human who
  // approved this decision may not be the person entitled to propose a
  // price. Checked here, on the actual governed table's own capability,
  // exactly like I5 checks purchase.request rather than trusting the
  // decision's own approval.
  try {
    await assertCapability(sb, userId, tenantId, "pricing.manage");
  } catch (err) {
    return failAction(sb, userId, action, tenantId, module, (err as Error).message);
  }

  const { data: menuItem, error: itemErr } = await sb
    .from("restaurant_menu_items")
    .select("id, tenant_id, price, currency")
    .eq("id", menuItemId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (itemErr) return failAction(sb, userId, action, tenantId, module, itemErr.message);
  if (!menuItem) {
    return failAction(
      sb,
      userId,
      action,
      tenantId,
      module,
      "The menu item this decision named does not exist for this tenant — refusing to raise a pricing review.",
    );
  }

  // The exact "current active price for this scope" lookup upsertPrice
  // itself uses (tenant scope, no property/location/price-list/channel
  // override) — the freshest read of what this item's restaurant_prices
  // override actually is, without invoking the full rule-set/promotion
  // pricing engine, which is out of scope here.
  const { data: activeRows, error: activeErr } = await sb
    .from("restaurant_prices")
    .select("id, version, amount, currency, status")
    .eq("tenant_id", tenantId)
    .eq("menu_item_id", menuItemId)
    .eq("scope", "tenant")
    .is("property_id", null)
    .is("location_id", null)
    .is("price_list_id", null)
    .is("channel", null)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1);
  if (activeErr) return failAction(sb, userId, action, tenantId, module, activeErr.message);
  const activePrice = ((activeRows ?? []) as any[])[0] ?? null;

  // Authoritative "what does this item sell for right now": the active
  // restaurant_prices override for this exact scope if one exists, else the
  // menu item's own price — the same precedence quoteWithRuleSet already
  // gives it (a scoped price candidate first, the menu item's price as
  // fallback), not a second interpretation invented here.
  const authoritativeAmount = activePrice
    ? Number(activePrice.amount)
    : Number(menuItem.price ?? 0);
  const authoritativeCurrency = activePrice
    ? activePrice.currency
    : (menuItem.currency ?? currency);

  // STALE PRICE PROTECTION: the decision was built from a price snapshot
  // that may no longer hold. Never overwrite a price that has moved since —
  // fail safely and name both figures so a human knows to re-run
  // intelligence rather than blindly re-approve.
  if (
    roundTo(authoritativeAmount, 2) !== roundTo(capturedCurrentPrice, 2) ||
    authoritativeCurrency !== currency
  ) {
    return failAction(
      sb,
      userId,
      action,
      tenantId,
      module,
      `Stale price: this recommendation was generated when the price was ${currency} ${roundTo(capturedCurrentPrice, 2)}, but the current price is now ${authoritativeCurrency} ${roundTo(authoritativeAmount, 2)}. Re-run intelligence and review this recommendation again before proceeding.`,
    );
  }

  const version = activePrice ? Number(activePrice.version) + 1 : 1;
  const supersedesId = activePrice ? activePrice.id : null;

  const { data: created, error: createErr } = await sb
    .from("restaurant_prices")
    .insert({
      tenant_id: tenantId,
      menu_item_id: menuItemId,
      scope: "tenant",
      property_id: null,
      location_id: null,
      price_list_id: null,
      channel: null,
      currency,
      amount: recommendedPrice,
      tax_inclusive: false,
      version,
      // Never 'active' — see file/function doc comments. Only a separate
      // decidePrice() call, gated on pricing.approve, can ever publish this.
      status: "pending_approval",
      effective_from: now(),
      reason:
        `${decision.decision_key} — ${finding.headline ?? "Intelligence pricing review"}`.slice(
          0,
          500,
        ),
      supersedes_id: supersedesId,
      requires_approval: true,
      created_by: userId,
      correlation_id: action.id,
    })
    .select("id, status")
    .single();
  if (createErr) {
    // Another concurrent execution of this exact action won the race and
    // already inserted the (tenant_id, correlation_id)-unique row — same
    // "already happened, not an error" recovery runProcurementDraftExecution
    // uses for its own dedupe key.
    if (String((createErr as any).code) === "23505") {
      const { data: recovered, error: recoverErr } = await sb
        .from("restaurant_prices")
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
            "Concurrent insert detected but the winning pricing review could not be recovered.",
        );
      }
      return finishMenuRepriceExecution(
        sb,
        userId,
        action,
        decision,
        tenantId,
        module,
        recovered.id,
        recovered.status,
      );
    }
    return failAction(sb, userId, action, tenantId, module, createErr.message);
  }
  if (!created) {
    return failAction(sb, userId, action, tenantId, module, "Failed to create the pricing review.");
  }

  // Same audit trail a human raising a price through the Pricing Centre
  // gets — an intelligence-created pricing review is not invisible to
  // whoever reviews restaurant_pricing_audit.
  await recordPricingAudit(sb, userId, {
    tenantId,
    entityType: "price",
    entityId: created.id,
    action: "price.created",
    previousValue: activePrice
      ? { amount: activePrice.amount, currency: activePrice.currency }
      : null,
    newValue: { amount: recommendedPrice, currency, status: "pending_approval" },
    reason: decision.decision_key,
    metadata: { origin: "intelligence", decision_id: decision.id, action_id: action.id },
  });

  return finishMenuRepriceExecution(
    sb,
    userId,
    action,
    decision,
    tenantId,
    module,
    created.id,
    created.status,
  );
}

/** Marks the action "executed" once its pricing review exists (fresh or recovered). */
async function finishMenuRepriceExecution(
  sb: Sb,
  userId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
  tenantId: string,
  module: string,
  priceReviewId: string,
  priceReviewStatus: string,
): Promise<ExecuteRestaurantActionResult> {
  await sb
    .from("intelligence_actions")
    .update({
      status: "executed",
      completed_at: now(),
      result: { price_review_id: priceReviewId, price_review_status: priceReviewStatus },
    })
    .eq("id", action.id);

  await emitActionEvent(sb, userId, {
    type: "intelligence.action.executed",
    tenantId,
    module,
    actionId: action.id,
    decisionId: decision.id,
    payload: { price_review_id: priceReviewId },
  });

  return {
    actionId: action.id,
    status: "executed",
    executionResult: "price_review_created",
    priceReviewId,
    priceReviewStatus,
  };
}

/**
 * I7 — the governed effect for `restaurant.kitchen.workflow_review`: a
 * `pending_review` row in `restaurant_operational_reviews` (see migration
 * 0021's doc comment for why this table exists — the same
 * unique(tenant_id, correlation_id) concurrency guarantee I5/I6 already
 * lean on, which no existing table offered for a kitchen review). This is
 * a recommendation, never a change: it never writes to
 * restaurant_kitchen_tickets, restaurant_stations, restaurant_order_items,
 * staffing, routing or recipes. A human reads the review and, if they
 * agree, makes any actual change through the existing station/staffing
 * tools this executor never touches.
 */
async function runKitchenWorkflowReviewExecution(
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
    detail?: string;
    facts?: Record<string, unknown>;
  };
  const facts = finding.facts ?? {};
  const stationId = facts.stationId;
  const stationName = facts.stationName;

  if (typeof stationId !== "string" || typeof stationName !== "string") {
    return failAction(
      sb,
      userId,
      action,
      tenantId,
      module,
      "The owning decision has no structured kitchen station data (stationId/stationName) — cannot raise a workflow review.",
    );
  }

  // Idempotency first, before any capability or station check, so a retry
  // of an already-completed action never re-runs (and never re-fails) those
  // checks against data that may have moved on since.
  const { data: existingByCorrelation, error: correlationErr } = await sb
    .from("restaurant_operational_reviews")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("correlation_id", action.id)
    .maybeSingle();
  if (correlationErr) {
    return failAction(sb, userId, action, tenantId, module, correlationErr.message);
  }
  if (existingByCorrelation) {
    return finishKitchenWorkflowReviewExecution(
      sb,
      userId,
      action,
      decision,
      tenantId,
      module,
      existingByCorrelation.id,
      existingByCorrelation.status,
    );
  }

  // Intelligence-decision approval is not kitchen-operations authority: the
  // human who approved this decision may not be the person entitled to
  // raise a kitchen review. Checked here, on the actual governed table's
  // own capability, exactly like I5 checks purchase.request and I6 checks
  // pricing.manage rather than trusting the decision's own approval.
  try {
    await assertCapability(sb, userId, tenantId, "kitchen.manage");
  } catch (err) {
    return failAction(sb, userId, action, tenantId, module, (err as Error).message);
  }

  const { data: station, error: stationErr } = await sb
    .from("restaurant_stations")
    .select("id, tenant_id, name")
    .eq("id", stationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (stationErr) return failAction(sb, userId, action, tenantId, module, stationErr.message);
  if (!station) {
    return failAction(
      sb,
      userId,
      action,
      tenantId,
      module,
      "The station this decision named does not exist for this tenant — refusing to raise a workflow review.",
    );
  }

  const recommendedOption = ((decision.options ?? []) as any[]).find(
    (o) => o.option?.key === decision.recommended_option_key,
  );
  const recommendation: string | null =
    recommendedOption?.option?.tactics?.join("; ") ?? recommendedOption?.option?.summary ?? null;

  const { data: created, error: createErr } = await sb
    .from("restaurant_operational_reviews")
    .insert({
      tenant_id: tenantId,
      property_id: decision.property_id ?? null,
      location_id: decision.location_id ?? null,
      decision_id: decision.id,
      review_type: "kitchen_workflow",
      station_id: stationId,
      title: finding.headline ?? `Review ${stationName}'s workflow`,
      detail: finding.detail ?? null,
      recommendation,
      facts,
      created_by: userId,
      correlation_id: action.id,
    })
    .select("id, status")
    .single();
  if (createErr) {
    // Another concurrent execution of this exact action won the race and
    // already inserted the (tenant_id, correlation_id)-unique row — same
    // "already happened, not an error" recovery runProcurementDraftExecution
    // and runMenuRepriceExecution use for their own dedupe keys.
    if (String((createErr as any).code) === "23505") {
      const { data: recovered, error: recoverErr } = await sb
        .from("restaurant_operational_reviews")
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
            "Concurrent insert detected but the winning workflow review could not be recovered.",
        );
      }
      return finishKitchenWorkflowReviewExecution(
        sb,
        userId,
        action,
        decision,
        tenantId,
        module,
        recovered.id,
        recovered.status,
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
      "Failed to create the workflow review.",
    );
  }

  return finishKitchenWorkflowReviewExecution(
    sb,
    userId,
    action,
    decision,
    tenantId,
    module,
    created.id,
    created.status,
  );
}

/** Marks the action "executed" once its workflow review exists (fresh or recovered). */
async function finishKitchenWorkflowReviewExecution(
  sb: Sb,
  userId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
  tenantId: string,
  module: string,
  reviewId: string,
  reviewStatus: string,
): Promise<ExecuteRestaurantActionResult> {
  await sb
    .from("intelligence_actions")
    .update({
      status: "executed",
      completed_at: now(),
      result: { workflow_review_id: reviewId, workflow_review_status: reviewStatus },
    })
    .eq("id", action.id);

  await emitActionEvent(sb, userId, {
    type: "intelligence.action.executed",
    tenantId,
    module,
    actionId: action.id,
    decisionId: decision.id,
    payload: { workflow_review_id: reviewId },
  });

  return {
    actionId: action.id,
    status: "executed",
    executionResult: "workflow_review_created",
    workflowReviewId: reviewId,
    workflowReviewStatus: reviewStatus,
  };
}

/**
 * I8 — the governed effect for `restaurant.kitchen.staffing_review`: a
 * `pending_review` row in the same `restaurant_operational_reviews` table
 * I7 uses, distinguished only by `review_type = "kitchen_staffing"`. No new
 * table: this action is proposed from the exact same `kitchen_capacity`
 * finding I7 reads (see optionCatalogue.ts's `kitchenOptions` — `add_staff`
 * is just another option on the same finding, alongside `adjust_workflow`/
 * `reallocate_stations`), so it needs the same facts (`stationId`/
 * `stationName`) and the same idempotency/capability/station-exists
 * guarantees, not a second implementation.
 *
 * The system has no shift/schedule/attendance/payroll data — only
 * `restaurant_members` role assignments — so this never claims a staffing
 * conclusion ("understaffed", "add N people") beyond the workload evidence
 * (tickets/delayed%/over-target%/prep minutes) the finding already carries.
 * `recommendation` below is the decision engine's own approved-option text,
 * recorded verbatim; this executor never invents or upgrades it. It never
 * writes to restaurant_members, staffing records, schedules, payroll,
 * station assignments, or kitchen routing/configuration.
 */
async function runKitchenStaffingReviewExecution(
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
    detail?: string;
    facts?: Record<string, unknown>;
  };
  const facts = finding.facts ?? {};
  const stationId = facts.stationId;
  const stationName = facts.stationName;

  if (typeof stationId !== "string" || typeof stationName !== "string") {
    return failAction(
      sb,
      userId,
      action,
      tenantId,
      module,
      "The owning decision has no structured kitchen station data (stationId/stationName) — cannot raise a staffing review.",
    );
  }

  // Idempotency first, before any capability or station check — identical
  // ordering to runKitchenWorkflowReviewExecution and for the same reason.
  const { data: existingByCorrelation, error: correlationErr } = await sb
    .from("restaurant_operational_reviews")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("correlation_id", action.id)
    .maybeSingle();
  if (correlationErr) {
    return failAction(sb, userId, action, tenantId, module, correlationErr.message);
  }
  if (existingByCorrelation) {
    return finishKitchenStaffingReviewExecution(
      sb,
      userId,
      action,
      decision,
      tenantId,
      module,
      existingByCorrelation.id,
      existingByCorrelation.status,
    );
  }

  // Same capability as I7's workflow review — kitchen.manage — not a new
  // "staffing" capability: this is still just "raise a kitchen operations
  // review", never staffing/schedule authority. Checked against the actual
  // governed table's capability, not trusted from the decision's approval.
  try {
    await assertCapability(sb, userId, tenantId, "kitchen.manage");
  } catch (err) {
    return failAction(sb, userId, action, tenantId, module, (err as Error).message);
  }

  const { data: station, error: stationErr } = await sb
    .from("restaurant_stations")
    .select("id, tenant_id, name")
    .eq("id", stationId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (stationErr) return failAction(sb, userId, action, tenantId, module, stationErr.message);
  if (!station) {
    return failAction(
      sb,
      userId,
      action,
      tenantId,
      module,
      "The station this decision named does not exist for this tenant — refusing to raise a staffing review.",
    );
  }

  // The engine's own approved-option text (e.g. add_staff's tactics), never
  // rewritten or strengthened into an invented headcount/HR conclusion.
  const recommendedOption = ((decision.options ?? []) as any[]).find(
    (o) => o.option?.key === decision.recommended_option_key,
  );
  const recommendation: string | null =
    recommendedOption?.option?.tactics?.join("; ") ?? recommendedOption?.option?.summary ?? null;

  const { data: created, error: createErr } = await sb
    .from("restaurant_operational_reviews")
    .insert({
      tenant_id: tenantId,
      property_id: decision.property_id ?? null,
      location_id: decision.location_id ?? null,
      decision_id: decision.id,
      review_type: "kitchen_staffing",
      station_id: stationId,
      title: finding.headline ?? `Review ${stationName}'s staffing/workload`,
      detail: finding.detail ?? null,
      recommendation,
      facts,
      created_by: userId,
      correlation_id: action.id,
    })
    .select("id, status")
    .single();
  if (createErr) {
    // Same concurrent-winner recovery as I7 — the (tenant_id, correlation_id)
    // unique constraint is what actually guarantees exactly one review.
    if (String((createErr as any).code) === "23505") {
      const { data: recovered, error: recoverErr } = await sb
        .from("restaurant_operational_reviews")
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
            "Concurrent insert detected but the winning staffing review could not be recovered.",
        );
      }
      return finishKitchenStaffingReviewExecution(
        sb,
        userId,
        action,
        decision,
        tenantId,
        module,
        recovered.id,
        recovered.status,
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
      "Failed to create the staffing review.",
    );
  }

  return finishKitchenStaffingReviewExecution(
    sb,
    userId,
    action,
    decision,
    tenantId,
    module,
    created.id,
    created.status,
  );
}

/** Marks the action "executed" once its staffing review exists (fresh or recovered). */
async function finishKitchenStaffingReviewExecution(
  sb: Sb,
  userId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
  tenantId: string,
  module: string,
  reviewId: string,
  reviewStatus: string,
): Promise<ExecuteRestaurantActionResult> {
  await sb
    .from("intelligence_actions")
    .update({
      status: "executed",
      completed_at: now(),
      result: { staffing_review_id: reviewId, staffing_review_status: reviewStatus },
    })
    .eq("id", action.id);

  await emitActionEvent(sb, userId, {
    type: "intelligence.action.executed",
    tenantId,
    module,
    actionId: action.id,
    decisionId: decision.id,
    payload: { staffing_review_id: reviewId },
  });

  return {
    actionId: action.id,
    status: "executed",
    executionResult: "staffing_review_created",
    staffingReviewId: reviewId,
    staffingReviewStatus: reviewStatus,
  };
}

type Verifier = (
  sb: Sb,
  tenantId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
) => Promise<VerifyRestaurantActionResult>;

/**
 * Only the action types that actually have an executor get a real verifier.
 * Every other type in the restaurant provider's `handles` list — and any
 * type this module doesn't own at all — returns "verification_unavailable"
 * rather than being reported as verified.
 */
const VERIFIERS: Record<string, Verifier> = {
  "restaurant.purchase.suggest": verifyProcurementDraft,
  "restaurant.inventory.replenish_review": verifyProcurementDraft,
  "restaurant.menu.reprice_review": verifyMenuRepriceReview,
  "restaurant.kitchen.workflow_review": verifyKitchenWorkflowReview,
  "restaurant.kitchen.staffing_review": verifyKitchenStaffingReview,
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

  await assertActionScope(
    sb,
    userId,
    decision.module,
    decision.tenant_id,
    decision.property_id ?? null,
    decision.location_id ?? null,
  );
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
 * state, and is not duplicated. Shared by both action types this module
 * executes (see file doc comment) — verification never depends on which
 * finding proposed the draft, only on what actually landed in the database.
 */
async function verifyProcurementDraft(
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

/**
 * I6 — independently re-reads the real `restaurant_prices` row a
 * reprice_review action was supposed to produce. Confirms it exists, is
 * scoped to the right tenant and menu item, carries the exact expected
 * amount/currency, is correlated to this action, is not duplicated, and —
 * critically — is still exactly `pending_approval`. That last check is not
 * cosmetic: it is the one place this module positively confirms the
 * governed effect stopped where it was supposed to and no live price was
 * published. If the row somehow reads `active`, this reports failure rather
 * than "verified" — an unintended live-price mutation must never be
 * reported as a successful, harmless review.
 */
async function verifyMenuRepriceReview(
  sb: Sb,
  tenantId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
): Promise<VerifyRestaurantActionResult> {
  const facts = (decision.context?.finding?.facts ?? {}) as Record<string, unknown>;
  const expectedAmount =
    typeof facts.recommendedPrice === "number" ? facts.recommendedPrice : undefined;
  const expectedMenuItemId = typeof facts.menuItemId === "string" ? facts.menuItemId : undefined;
  const expectedCurrency = typeof facts.currency === "string" ? facts.currency : undefined;

  const expectedReviewId = action.result?.price_review_id as string | undefined;
  if (!expectedReviewId) {
    return {
      verified: false,
      outcome: "price_review_missing",
      reason: "The action has no recorded price_review_id to verify.",
    };
  }

  const { data: review, error } = await sb
    .from("restaurant_prices")
    .select("id, tenant_id, menu_item_id, correlation_id, amount, currency, status")
    .eq("id", expectedReviewId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!review) {
    return {
      verified: false,
      outcome: "price_review_missing",
      entityType: "price_review",
      entityId: expectedReviewId,
      reason: `Pricing review ${expectedReviewId} does not exist.`,
    };
  }
  if (review.tenant_id !== tenantId) {
    return {
      verified: false,
      outcome: "tenant_mismatch",
      entityType: "price_review",
      entityId: review.id,
      reason: "The pricing review belongs to a different tenant.",
    };
  }
  if (review.correlation_id !== action.id) {
    return {
      verified: false,
      outcome: "correlation_mismatch",
      entityType: "price_review",
      entityId: review.id,
      reason: "The pricing review's correlation_id does not match this action.",
    };
  }
  if (expectedMenuItemId && review.menu_item_id !== expectedMenuItemId) {
    return {
      verified: false,
      outcome: "item_missing",
      entityType: "price_review",
      entityId: review.id,
      reason: `Expected menu item ${expectedMenuItemId} but the review is for ${review.menu_item_id ?? "(none)"}.`,
    };
  }

  const actualAmount = Number(review.amount);
  if (expectedAmount != null && roundTo(actualAmount, 2) !== roundTo(expectedAmount, 2)) {
    return {
      verified: false,
      outcome: "amount_mismatch",
      entityType: "price_review",
      entityId: review.id,
      expectedAmount,
      actualAmount,
      reason: `Expected proposed price ${expectedAmount}, found ${actualAmount}.`,
    };
  }
  if (expectedCurrency && review.currency !== expectedCurrency) {
    return {
      verified: false,
      outcome: "currency_mismatch",
      entityType: "price_review",
      entityId: review.id,
      reason: `Expected currency ${expectedCurrency}, found ${review.currency}.`,
    };
  }

  if (review.status !== "pending_approval") {
    return {
      verified: false,
      outcome: "unexpected_status",
      entityType: "price_review",
      entityId: review.id,
      status: review.status,
      reason: `Expected the review to remain "pending_approval" (governed, not yet published); found "${review.status}".`,
    };
  }

  const { data: dupes, error: dupErr } = await sb
    .from("restaurant_prices")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("correlation_id", action.id);
  if (dupErr) throw new Error(dupErr.message);
  const dupeCount = (dupes ?? []).length;
  if (dupeCount > 1) {
    return {
      verified: false,
      outcome: "duplicate_review",
      entityType: "price_review",
      entityId: review.id,
      reason: `Found ${dupeCount} pricing reviews correlated to this action — expected exactly 1.`,
    };
  }

  return {
    verified: true,
    outcome: "price_review_created",
    entityType: "price_review",
    entityId: review.id,
    expectedAmount,
    actualAmount,
    status: review.status,
  };
}

/**
 * I7 — independently re-reads the real `restaurant_operational_reviews` row
 * a workflow_review action was supposed to produce. Confirms it exists, is
 * scoped to the right tenant, is correlated to this action, references the
 * expected decision and station, remains in the expected governed
 * ("pending_review") state, and is not duplicated. Every value comes from a
 * fresh database read, exactly like verifyProcurementDraft/
 * verifyMenuRepriceReview — nothing here is inferred from the action's own
 * cached result.
 */
async function verifyKitchenWorkflowReview(
  sb: Sb,
  tenantId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
): Promise<VerifyRestaurantActionResult> {
  const facts = (decision.context?.finding?.facts ?? {}) as Record<string, unknown>;
  const expectedStationId = typeof facts.stationId === "string" ? facts.stationId : undefined;

  const expectedReviewId = action.result?.workflow_review_id as string | undefined;
  if (!expectedReviewId) {
    return {
      verified: false,
      outcome: "workflow_review_missing",
      reason: "The action has no recorded workflow_review_id to verify.",
    };
  }

  const { data: review, error } = await sb
    .from("restaurant_operational_reviews")
    .select("id, tenant_id, decision_id, station_id, correlation_id, status")
    .eq("id", expectedReviewId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!review) {
    return {
      verified: false,
      outcome: "workflow_review_missing",
      entityType: "workflow_review",
      entityId: expectedReviewId,
      reason: `Workflow review ${expectedReviewId} does not exist.`,
    };
  }
  if (review.tenant_id !== tenantId) {
    return {
      verified: false,
      outcome: "tenant_mismatch",
      entityType: "workflow_review",
      entityId: review.id,
      reason: "The workflow review belongs to a different tenant.",
    };
  }
  if (review.correlation_id !== action.id) {
    return {
      verified: false,
      outcome: "correlation_mismatch",
      entityType: "workflow_review",
      entityId: review.id,
      reason: "The workflow review's correlation_id does not match this action.",
    };
  }
  if (review.decision_id !== decision.id) {
    return {
      verified: false,
      outcome: "decision_mismatch",
      entityType: "workflow_review",
      entityId: review.id,
      reason: "The workflow review references a different decision.",
    };
  }
  if (expectedStationId && review.station_id !== expectedStationId) {
    return {
      verified: false,
      outcome: "station_mismatch",
      entityType: "workflow_review",
      entityId: review.id,
      reason: `Expected station ${expectedStationId} but the review is for ${review.station_id ?? "(none)"}.`,
    };
  }

  if (review.status !== "pending_review") {
    return {
      verified: false,
      outcome: "unexpected_status",
      entityType: "workflow_review",
      entityId: review.id,
      status: review.status,
      reason: `Expected the review to remain "pending_review" (governed, recommendation only); found "${review.status}".`,
    };
  }

  const { data: dupes, error: dupErr } = await sb
    .from("restaurant_operational_reviews")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("correlation_id", action.id);
  if (dupErr) throw new Error(dupErr.message);
  const dupeCount = (dupes ?? []).length;
  if (dupeCount > 1) {
    return {
      verified: false,
      outcome: "duplicate_review",
      entityType: "workflow_review",
      entityId: review.id,
      reason: `Found ${dupeCount} workflow reviews correlated to this action — expected exactly 1.`,
    };
  }

  return {
    verified: true,
    outcome: "workflow_review_created",
    entityType: "workflow_review",
    entityId: review.id,
    status: review.status,
  };
}

/**
 * I8 — independently re-reads the real `restaurant_operational_reviews` row
 * a staffing_review action was supposed to produce. Same checks as
 * verifyKitchenWorkflowReview, plus a `review_type` check (a staffing
 * review must actually read "kitchen_staffing", not another domain's
 * review type sharing the same table) — the task's "review type is
 * staffing" requirement. Every value comes from a fresh database read.
 */
async function verifyKitchenStaffingReview(
  sb: Sb,
  tenantId: string,
  action: Record<string, any>,
  decision: Record<string, any>,
): Promise<VerifyRestaurantActionResult> {
  const facts = (decision.context?.finding?.facts ?? {}) as Record<string, unknown>;
  const expectedStationId = typeof facts.stationId === "string" ? facts.stationId : undefined;

  const expectedReviewId = action.result?.staffing_review_id as string | undefined;
  if (!expectedReviewId) {
    return {
      verified: false,
      outcome: "staffing_review_missing",
      reason: "The action has no recorded staffing_review_id to verify.",
    };
  }

  const { data: review, error } = await sb
    .from("restaurant_operational_reviews")
    .select("id, tenant_id, decision_id, station_id, review_type, correlation_id, status")
    .eq("id", expectedReviewId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!review) {
    return {
      verified: false,
      outcome: "staffing_review_missing",
      entityType: "staffing_review",
      entityId: expectedReviewId,
      reason: `Staffing review ${expectedReviewId} does not exist.`,
    };
  }
  if (review.tenant_id !== tenantId) {
    return {
      verified: false,
      outcome: "tenant_mismatch",
      entityType: "staffing_review",
      entityId: review.id,
      reason: "The staffing review belongs to a different tenant.",
    };
  }
  if (review.correlation_id !== action.id) {
    return {
      verified: false,
      outcome: "correlation_mismatch",
      entityType: "staffing_review",
      entityId: review.id,
      reason: "The staffing review's correlation_id does not match this action.",
    };
  }
  if (review.decision_id !== decision.id) {
    return {
      verified: false,
      outcome: "decision_mismatch",
      entityType: "staffing_review",
      entityId: review.id,
      reason: "The staffing review references a different decision.",
    };
  }
  if (review.review_type !== "kitchen_staffing") {
    return {
      verified: false,
      outcome: "review_type_mismatch",
      entityType: "staffing_review",
      entityId: review.id,
      reason: `Expected review_type "kitchen_staffing" but found "${review.review_type}".`,
    };
  }
  if (expectedStationId && review.station_id !== expectedStationId) {
    return {
      verified: false,
      outcome: "station_mismatch",
      entityType: "staffing_review",
      entityId: review.id,
      reason: `Expected station ${expectedStationId} but the review is for ${review.station_id ?? "(none)"}.`,
    };
  }

  if (review.status !== "pending_review") {
    return {
      verified: false,
      outcome: "unexpected_status",
      entityType: "staffing_review",
      entityId: review.id,
      status: review.status,
      reason: `Expected the review to remain "pending_review" (governed, recommendation only); found "${review.status}".`,
    };
  }

  const { data: dupes, error: dupErr } = await sb
    .from("restaurant_operational_reviews")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("correlation_id", action.id);
  if (dupErr) throw new Error(dupErr.message);
  const dupeCount = (dupes ?? []).length;
  if (dupeCount > 1) {
    return {
      verified: false,
      outcome: "duplicate_review",
      entityType: "staffing_review",
      entityId: review.id,
      reason: `Found ${dupeCount} staffing reviews correlated to this action — expected exactly 1.`,
    };
  }

  return {
    verified: true,
    outcome: "staffing_review_created",
    entityType: "staffing_review",
    entityId: review.id,
    status: review.status,
  };
}

/**
 * I11 — the one genuine gap the audit found: nothing previously discovered
 * approved actions on its own. `executeRestaurantAction` was already a
 * complete, idempotent, concurrency-safe state machine (`guardedTransition`,
 * `alreadyExecutedResult`, correlation-based crash recovery) — but every
 * call required a client-supplied `actionId` from a per-row UI button. This
 * function adds ONLY discovery + dispatch: it finds this tenant's real
 * `approved` restaurant actions from the database and calls the existing,
 * unmodified `executeRestaurantAction` for each one. It duplicates none of
 * that executor's logic, and it never calls `verifyRestaurantAction` — Act
 * and Verify stay two distinct, separately-triggerable operations, exactly
 * as P10 established.
 *
 * Concurrency and idempotency are inherited, not reimplemented: two callers
 * running this at the same time each discover the same approved rows and
 * each call `executeRestaurantAction` for them, which races on the exact
 * same `guardedTransition` (`UPDATE ... WHERE status = 'approved' ...
 * RETURNING`) a single manual "Execute" click already goes through — only
 * one side of the race performs each transition, and a loser that catches
 * up mid-run recovers the winner's result rather than duplicating it.
 *
 * This function creates nothing, approves nothing, and expands no
 * executor's authority — it is a discovery+fan-out shim over machinery
 * that already existed and was already safe.
 */
export interface OrchestrateApprovedRestaurantActionsResult {
  discovered: number;
  outcomes: Array<
    { actionId: string; decisionKey: string; actionType: string } & (
      ExecuteRestaurantActionResult | { status: "failed"; failureReason: string }
    )
  >;
}

export async function orchestrateApprovedRestaurantActions(
  sb: Sb,
  userId: string,
  input: { tenantId: string; limit?: number },
): Promise<OrchestrateApprovedRestaurantActionsResult> {
  // Same tenant-wide read gate "Run decision pass" / "Check for updates"
  // already use — this is a discovery sweep over intelligence state, not a
  // new authority. Every dispatched execution still passes through
  // executeRestaurantAction's own assertActionScope and each executor's own
  // capability check (purchase.request, pricing.manage, ...) independently.
  await assertCapability(sb, userId, input.tenantId, "intelligence.read");
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  // Real discovery, never a client-supplied list: which decisions belong to
  // this tenant, then which of THEIR actions are genuinely "approved" right
  // now. intelligence_actions carries no tenant_id of its own (0011) — its
  // tenant is only ever established by joining back through decision_id,
  // exactly like every other tenant-scoped read of this table.
  const { data: decisionRows, error: decisionErr } = await sb
    .from("intelligence_decisions")
    .select("id, decision_key")
    .eq("module", "restaurant")
    .eq("tenant_id", input.tenantId);
  if (decisionErr) throw new Error(decisionErr.message);
  const decisionKeyById = new Map<string, string>(
    ((decisionRows ?? []) as Array<{ id: string; decision_key: string }>).map((d) => [
      d.id,
      d.decision_key,
    ]),
  );
  if (decisionKeyById.size === 0) return { discovered: 0, outcomes: [] };

  const { data: actionRows, error: actionErr } = await sb
    .from("intelligence_actions")
    .select("id, decision_id, action_type, status")
    .in("decision_id", Array.from(decisionKeyById.keys()))
    .order("created_at", { ascending: true });
  if (actionErr) throw new Error(actionErr.message);
  // Discovery-eligible = "approved" (never yet attempted) or "failed" (a
  // prior attempt hit a recoverable error — executeRestaurantAction's own
  // RESUMABLE_STATUSES already treats "failed" as safely retryable; without
  // including it here, a transient failure would only ever be retried by a
  // human clicking the per-row Execute button again, not by this sweep).
  // "queued"/"executing" are deliberately excluded — those are already
  // being worked, by this call or a concurrent one, and re-dispatching them
  // adds nothing (guardedTransition would just lose the race harmlessly).
  // Filtered and bounded in JS rather than in the query: intelligence_actions
  // is a low-cardinality governance table, not high-volume, and this avoids
  // a second .in()-style filter alongside the decision_id scoping above.
  const eligible = (
    (actionRows ?? []) as Array<{
      id: string;
      decision_id: string;
      action_type: string;
      status: string;
    }>
  )
    .filter((a) => a.status === "approved" || a.status === "failed")
    .slice(0, limit);

  const outcomes: OrchestrateApprovedRestaurantActionsResult["outcomes"] = [];
  for (const row of eligible) {
    const decisionKey = decisionKeyById.get(row.decision_id) ?? "";
    try {
      const result = await executeRestaurantAction(sb, userId, { actionId: row.id });
      outcomes.push({
        ...result,
        actionId: row.id,
        decisionKey,
        actionType: row.action_type,
      });
    } catch (err) {
      // An unsupported action type, or an executor-level authorization
      // failure, throws before executeRestaurantAction writes anything —
      // the row stays exactly "approved" (never silently dropped from
      // discovery; the next sweep reports the same failure again until a
      // human resolves it). Captured here, not swallowed.
      outcomes.push({
        actionId: row.id,
        decisionKey,
        actionType: row.action_type,
        status: "failed",
        failureReason: (err as Error).message,
      });
    }
  }

  return { discovered: eligible.length, outcomes };
}
