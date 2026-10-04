/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this orchestration boundary. */
/**
 * LexiBite Inventory Agent V1 — Replenishment Orchestrator.
 *
 * This is deliberately an orchestration layer, not a second inventory or
 * procurement system. It reuses the existing restaurant Intelligence Core,
 * decision lifecycle, governed procurement-draft executor, and independent
 * verification.
 *
 * V1 authority boundary:
 * - observes and reasons through the existing restaurant decision pass;
 * - surfaces replenishment recommendations with live evidence;
 * - discovers ONLY approved inventory-replenishment actions;
 * - executes those approved actions through executeRestaurantAction;
 * - verifies executed actions through verifyRestaurantAction;
 * - never approves a decision, creates a PO directly, contacts suppliers,
 *   mutates stock, changes inventory balances, or pays anyone.
 */
import { assertCapability } from "../core/access.server";
import {
  executeRestaurantAction,
  verifyRestaurantAction,
  type ExecuteRestaurantActionResult,
  type VerifyRestaurantActionResult,
} from "../decisions/actions.server";
import { runRestaurantDecisionPass } from "../decisions/decisions.server";
import type { RestaurantFinding } from "../decisions/decision.types";

type Sb = any;

const INVENTORY_ACTION_TYPE = "restaurant.inventory.replenish_review";
const INVENTORY_FINDING_KINDS = new Set([
  "inventory_shortage",
  "purchasing_replenishment",
]);

export interface InventoryAgentRunInput {
  tenantId: string;
  windowDays?: number;
  propertyId?: string;
  locationId?: string;
}

export interface InventoryAgentRecommendation {
  decisionId: string;
  decisionKey: string;
  status: string;
  findingKind: string;
  subject: string;
  severity: string;
  confidence: number;
  headline: string;
  facts: Record<string, unknown>;
  recommendedOptionKey: string | null;
  recommendedActionType: string | null;
  actionId: string | null;
  actionStatus: string | null;
  verification: Record<string, unknown> | null;
}

export interface InventoryAgentRunResult {
  generatedAt: string;
  decisionPass: Awaited<ReturnType<typeof runRestaurantDecisionPass>>;
  recommendations: InventoryAgentRecommendation[];
}

/**
 * Observe → Understand → Reason → Recommend.
 *
 * The recommendation is always rebuilt from current restaurant intelligence.
 * Existing proposed decisions are reconciled by the canonical decision pass;
 * already-reviewed decisions are preserved by its governance rules.
 */
export async function runInventoryAgent(
  sb: Sb,
  userId: string,
  input: InventoryAgentRunInput,
): Promise<InventoryAgentRunResult> {
  const windowDays = input.windowDays ?? 30;

  const decisionPass = await runRestaurantDecisionPass(sb, userId, {
    tenantId: input.tenantId,
    windowDays,
    persist: true,
    propertyId: input.propertyId,
    locationId: input.locationId,
  });

  let decisionQuery = sb
    .from("intelligence_decisions")
    .select(
      "id, decision_key, status, confidence, recommended_option_key, options, context, action_id, property_id, location_id, created_at, updated_at",
    )
    .eq("module", "restaurant")
    .eq("tenant_id", input.tenantId)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (input.propertyId) decisionQuery = decisionQuery.eq("property_id", input.propertyId);
  if (input.locationId) decisionQuery = decisionQuery.eq("location_id", input.locationId);

  const { data: decisions, error: decisionError } = await decisionQuery;
  if (decisionError) throw new Error(decisionError.message);

  const inventoryDecisions = ((decisions ?? []) as any[]).filter((row) => {
    const kind = row.context?.finding?.kind;
    if (INVENTORY_FINDING_KINDS.has(kind)) return true;
    return ((row.options ?? []) as any[]).some(
      (option) => option?.option?.actionType === INVENTORY_ACTION_TYPE,
    );
  });

  const actionIds = inventoryDecisions
    .map((row) => row.action_id)
    .filter((id): id is string => typeof id === "string");

  const { data: actions, error: actionError } = actionIds.length
    ? await sb
        .from("intelligence_actions")
        .select("id, status, verification_result")
        .in("id", actionIds)
    : { data: [], error: null };

  if (actionError) throw new Error(actionError.message);

  const actionById = new Map<string, any>(
    ((actions ?? []) as any[]).map((action) => [action.id, action]),
  );

  const recommendations: InventoryAgentRecommendation[] = inventoryDecisions.map((row) => {
    const finding = (row.context?.finding ?? {}) as Partial<RestaurantFinding>;
    const selected = ((row.options ?? []) as any[]).find(
      (option) => option?.option?.key === row.recommended_option_key,
    );
    const action = row.action_id ? actionById.get(row.action_id) : null;

    return {
      decisionId: row.id,
      decisionKey: row.decision_key,
      status: row.status,
      findingKind: String(finding.kind ?? "unknown"),
      subject: String(finding.subject ?? "Unknown inventory issue"),
      severity: String(finding.severity ?? "unknown"),
      confidence: Number(row.confidence ?? 0),
      headline: String(finding.headline ?? row.decision_key),
      facts: (finding.facts ?? {}) as Record<string, unknown>,
      recommendedOptionKey: row.recommended_option_key ?? null,
      recommendedActionType: selected?.option?.actionType ?? null,
      actionId: row.action_id ?? null,
      actionStatus: action?.status ?? null,
      verification: action?.verification_result ?? null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    decisionPass,
    recommendations,
  };
}

export interface InventoryAgentActionSweepResult {
  discovered: number;
  outcomes: Array<
    {
      actionId: string;
      decisionId: string;
      decisionKey: string;
      actionType: string;
    } & (ExecuteRestaurantActionResult | { status: "failed"; failureReason: string })
  >;
}

/**
 * Approved → Action.
 *
 * Discovery is restricted to the inventory agent's own action type. Human
 * approval is still required; this function cannot approve anything.
 */
export async function executeApprovedInventoryAgentActions(
  sb: Sb,
  userId: string,
  input: { tenantId: string; limit?: number; propertyId?: string; locationId?: string },
): Promise<InventoryAgentActionSweepResult> {
  await assertCapability(sb, userId, input.tenantId, "intelligence.read");

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  let decisionQuery = sb
    .from("intelligence_decisions")
    .select("id, decision_key, property_id, location_id")
    .eq("module", "restaurant")
    .eq("tenant_id", input.tenantId);

  if (input.propertyId) decisionQuery = decisionQuery.eq("property_id", input.propertyId);
  if (input.locationId) decisionQuery = decisionQuery.eq("location_id", input.locationId);

  const { data: decisions, error: decisionError } = await decisionQuery;
  if (decisionError) throw new Error(decisionError.message);

  const decisionRows = (decisions ?? []) as Array<{
    id: string;
    decision_key: string;
    property_id: string | null;
    location_id: string | null;
  }>;
  if (decisionRows.length === 0) return { discovered: 0, outcomes: [] };

  const decisionById = new Map(decisionRows.map((row) => [row.id, row]));

  const { data: actions, error: actionError } = await sb
    .from("intelligence_actions")
    .select("id, decision_id, action_type, status, created_at")
    .in("decision_id", decisionRows.map((row) => row.id))
    .eq("action_type", INVENTORY_ACTION_TYPE)
    .order("created_at", { ascending: true });

  if (actionError) throw new Error(actionError.message);

  const eligible = ((actions ?? []) as Array<{
    id: string;
    decision_id: string;
    action_type: string;
    status: string;
  }>)
    .filter((row) => row.status === "approved" || row.status === "failed")
    .slice(0, limit);

  const outcomes: InventoryAgentActionSweepResult["outcomes"] = [];

  for (const row of eligible) {
    const decision = decisionById.get(row.decision_id);
    if (!decision) continue;

    try {
      const result = await executeRestaurantAction(sb, userId, { actionId: row.id });
      outcomes.push({
        ...result,
        actionId: row.id,
        decisionId: decision.id,
        decisionKey: decision.decision_key,
        actionType: row.action_type,
      });
    } catch (err) {
      outcomes.push({
        actionId: row.id,
        decisionId: decision.id,
        decisionKey: decision.decision_key,
        actionType: row.action_type,
        status: "failed",
        failureReason: (err as Error).message,
      });
    }
  }

  return { discovered: eligible.length, outcomes };
}

export interface InventoryAgentVerificationSweepResult {
  discovered: number;
  outcomes: Array<{
    actionId: string;
    decisionId: string;
    decisionKey: string;
    verification: VerifyRestaurantActionResult;
  }>;
}

/**
 * Executed → Verify.
 *
 * Verification remains a fresh read against the governed downstream
 * procurement-request record. It is intentionally not fused into execution.
 */
export async function verifyExecutedInventoryAgentActions(
  sb: Sb,
  userId: string,
  input: { tenantId: string; limit?: number; propertyId?: string; locationId?: string },
): Promise<InventoryAgentVerificationSweepResult> {
  await assertCapability(sb, userId, input.tenantId, "intelligence.read");

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  let decisionQuery = sb
    .from("intelligence_decisions")
    .select("id, decision_key, property_id, location_id")
    .eq("module", "restaurant")
    .eq("tenant_id", input.tenantId);

  if (input.propertyId) decisionQuery = decisionQuery.eq("property_id", input.propertyId);
  if (input.locationId) decisionQuery = decisionQuery.eq("location_id", input.locationId);

  const { data: decisions, error: decisionError } = await decisionQuery;
  if (decisionError) throw new Error(decisionError.message);
  const decisionRows = (decisions ?? []) as Array<{
    id: string;
    decision_key: string;
    property_id: string | null;
    location_id: string | null;
  }>;
  if (decisionRows.length === 0) return { discovered: 0, outcomes: [] };

  const decisionById = new Map(decisionRows.map((row) => [row.id, row]));

  const { data: actions, error: actionError } = await sb
    .from("intelligence_actions")
    .select("id, decision_id, action_type, status, created_at")
    .in("decision_id", decisionRows.map((row) => row.id))
    .eq("action_type", INVENTORY_ACTION_TYPE)
    .eq("status", "executed")
    .order("created_at", { ascending: true });

  if (actionError) throw new Error(actionError.message);

  const eligible = ((actions ?? []) as Array<{
    id: string;
    decision_id: string;
    action_type: string;
    status: string;
  }>).slice(0, limit);

  const outcomes: InventoryAgentVerificationSweepResult["outcomes"] = [];
  for (const row of eligible) {
    const decision = decisionById.get(row.decision_id);
    if (!decision) continue;

    try {
      const verification = await verifyRestaurantAction(sb, userId, { actionId: row.id });
      outcomes.push({
        actionId: row.id,
        decisionId: decision.id,
        decisionKey: decision.decision_key,
        verification,
      });
    } catch (err) {
      outcomes.push({
        actionId: row.id,
        decisionId: decision.id,
        decisionKey: decision.decision_key,
        verification: {
          verified: false,
          outcome: "verification_error",
          reason: (err as Error).message,
        },
      });
    }
  }

  return { discovered: eligible.length, outcomes };
}
