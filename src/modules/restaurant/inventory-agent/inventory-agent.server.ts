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
import { assertEntitled } from "@/modules/commercial/resolver.server";
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
const INVENTORY_FINDING_KINDS = new Set(["inventory_shortage", "purchasing_replenishment"]);

const DECISION_PAGE_SIZE = 500;
const ACTION_ID_BATCH_SIZE = 100;

type DecisionScope = { propertyId?: string; locationId?: string };

/** Read every scoped decision in bounded pages; never silently drop inventory findings behind a fixed newest-50 window. */
async function fetchTenantDecisions(
  sb: Sb,
  tenantId: string,
  scope: DecisionScope,
  columns: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; ; offset += DECISION_PAGE_SIZE) {
    let query = sb
      .from("intelligence_decisions")
      .select(columns)
      .eq("module", "restaurant")
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false })
      .range(offset, offset + DECISION_PAGE_SIZE - 1);
    if (scope.propertyId) query = query.eq("property_id", scope.propertyId);
    if (scope.locationId) query = query.eq("location_id", scope.locationId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as any[];
    rows.push(...page);
    if (page.length < DECISION_PAGE_SIZE) return rows;
  }
}

/** Bound PostgREST IN lists and propagate every query failure instead of silently losing actions. */
async function fetchActionsForDecisionIds(
  sb: Sb,
  decisionIds: string[],
  columns: string,
  filters: { actionType?: string; status?: string; unverifiedOnly?: boolean } = {},
): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < decisionIds.length; offset += ACTION_ID_BATCH_SIZE) {
    const batch = decisionIds.slice(offset, offset + ACTION_ID_BATCH_SIZE);
    let query = sb
      .from("intelligence_actions")
      .select(columns)
      .in("decision_id", batch)
      .order("created_at", { ascending: true });
    if (filters.actionType) query = query.eq("action_type", filters.actionType);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.unverifiedOnly) query = query.is("verified_at", null);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as any[]));
  }
  return rows;
}

async function fetchActionsByIds(
  sb: Sb,
  actionIds: string[],
  columns: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < actionIds.length; offset += ACTION_ID_BATCH_SIZE) {
    const batch = actionIds.slice(offset, offset + ACTION_ID_BATCH_SIZE);
    const { data, error } = await sb
      .from("intelligence_actions")
      .select(columns)
      .in("id", batch);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as any[]));
  }
  return rows;
}

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

  await assertEntitled(sb, input.tenantId, "inventory_agent", {
    propertyId: input.propertyId ?? null,
  });

  const decisionPass = await runRestaurantDecisionPass(sb, userId, {
    tenantId: input.tenantId,
    windowDays,
    persist: true,
    propertyId: input.propertyId,
    locationId: input.locationId,
  });

  const decisions = await fetchTenantDecisions(
    sb,
    input.tenantId,
    { propertyId: input.propertyId, locationId: input.locationId },
    "id, decision_key, status, confidence, recommended_option_key, options, context, action_id, property_id, location_id, created_at, updated_at",
  );

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

  const actions = actionIds.length
    ? await fetchActionsByIds(sb, actionIds, "id, status, verification_result")
    : [];

  const actionById = new Map<string, any>(actions.map((action) => [action.id, action]));

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
  await assertEntitled(sb, input.tenantId, "inventory_agent", {
    propertyId: input.propertyId ?? null,
  });
  await assertCapability(sb, userId, input.tenantId, "intelligence.read");

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  const decisions = await fetchTenantDecisions(
    sb,
    input.tenantId,
    { propertyId: input.propertyId, locationId: input.locationId },
    "id, decision_key, property_id, location_id",
  );

  const decisionRows = decisions as Array<{
    id: string;
    decision_key: string;
    property_id: string | null;
    location_id: string | null;
  }>;
  if (decisionRows.length === 0) return { discovered: 0, outcomes: [] };

  const decisionById = new Map(decisionRows.map((row) => [row.id, row]));

  const actions = await fetchActionsForDecisionIds(
    sb,
    decisionRows.map((row) => row.id),
    "id, decision_id, action_type, status, created_at",
    { actionType: INVENTORY_ACTION_TYPE },
  );

  const eligible = (
    actions as Array<{
      id: string;
      decision_id: string;
      action_type: string;
      status: string;
    }>
  )
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
  await assertEntitled(sb, input.tenantId, "inventory_agent", {
    propertyId: input.propertyId ?? null,
  });
  await assertCapability(sb, userId, input.tenantId, "intelligence.read");

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  const decisions = await fetchTenantDecisions(
    sb,
    input.tenantId,
    { propertyId: input.propertyId, locationId: input.locationId },
    "id, decision_key, property_id, location_id",
  );
  const decisionRows = decisions as Array<{
    id: string;
    decision_key: string;
    property_id: string | null;
    location_id: string | null;
  }>;
  if (decisionRows.length === 0) return { discovered: 0, outcomes: [] };

  const decisionById = new Map(decisionRows.map((row) => [row.id, row]));

  const actions = await fetchActionsForDecisionIds(
    sb,
    decisionRows.map((row) => row.id),
    "id, decision_id, action_type, status, created_at, verified_at",
    { actionType: INVENTORY_ACTION_TYPE, status: "executed", unverifiedOnly: true },
  );

  const eligible = (
    actions as Array<{
      id: string;
      decision_id: string;
      action_type: string;
      status: string;
      created_at?: string;
      verified_at?: string | null;
    }>
  )
    .filter(
      (row) =>
        row.action_type === INVENTORY_ACTION_TYPE &&
        row.status === "executed" &&
        !row.verified_at,
    )
    .slice(0, limit);

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
