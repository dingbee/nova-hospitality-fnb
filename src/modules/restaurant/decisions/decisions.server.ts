/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Phase 4 — Restaurant decision persistence.
 *
 * Reads Phase 3 intelligence, promotes findings into decisions, and stores them
 * in the SAME Intelligence Core ledger (`intelligence_decisions`,
 * `intelligence_plans`, `intelligence_plan_steps`) under module "restaurant".
 * Approval, action creation, outcome capture and learning are handled by the
 * existing core governance functions — nothing is duplicated here.
 *
 * The engine never writes to restaurant operational tables. It proposes.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { getInventoryIntelligence } from "../intelligence/inventory.server";
import { getKitchenIntelligence } from "../intelligence/kitchen.server";
import { getMenuIntelligence } from "../intelligence/menu.server";
import { getPurchasingIntelligence } from "../intelligence/purchasing.server";
import { gatherFindings } from "./findings";
import { buildRestaurantDecisions, restaurantDecisionHeadline } from "./restaurantDecisionEngine";
import type {
  RestaurantDecisionBoard,
  RestaurantDecisionBoardInput,
  RestaurantDecisionPassResult,
  RunRestaurantDecisionPassInput,
} from "./decision.types";
import type { StoredDecision } from "@/modules/intelligence/decisions/decision.types";

type Sb = any;

async function evaluate(sb: Sb, userId: string, tenantId: string, windowDays: number) {
  const [menu, inventory, kitchen, purchasing] = await Promise.all([
    getMenuIntelligence(sb, userId, { tenantId, windowDays }),
    getInventoryIntelligence(sb, userId, { tenantId, windowDays }),
    getKitchenIntelligence(sb, userId, { tenantId, windowDays }),
    getPurchasingIntelligence(sb, userId, { tenantId, windowDays }),
  ]);
  const findings = gatherFindings({ menu, inventory, kitchen, purchasing });
  return { findings, candidates: buildRestaurantDecisions(findings, tenantId) };
}

function stepRow(s: any) {
  return {
    sequence: Number(s.sequence),
    title: s.title,
    objective: s.objective,
    module: s.module,
    responsibleRole: s.responsible_role ?? "",
    dependsOn: s.depends_on === null || s.depends_on === undefined ? null : Number(s.depends_on),
    requiresApproval: !!s.requires_approval,
    expectedOutcome: s.expected_outcome ?? "",
    status: s.status,
  };
}

/** Persisted restaurant decisions for this tenant, newest first. */
async function loadStored(sb: Sb, tenantId: string): Promise<StoredDecision[]> {
  const { data } = await sb
    .from("intelligence_decisions")
    .select("*")
    .eq("module", "restaurant")
    .like("decision_key", `restaurant.${tenantId}.%`)
    .order("created_at", { ascending: false })
    .limit(25);
  const rows = (data ?? []) as any[];
  if (rows.length === 0) return [];

  const { data: plans } = await sb
    .from("intelligence_plans")
    .select("id, decision_id, objective, status")
    .in("decision_id", rows.map((r) => r.id));
  const planRows = (plans ?? []) as any[];

  const { data: steps } = planRows.length
    ? await sb
        .from("intelligence_plan_steps")
        .select("*")
        .in("plan_id", planRows.map((p) => p.id))
        .order("sequence", { ascending: true })
    : { data: [] as any[] };

  const byPlan = new Map<string, any[]>();
  for (const s of (steps ?? []) as any[]) byPlan.set(s.plan_id, [...(byPlan.get(s.plan_id) ?? []), s]);

  return rows.map((row) => {
    const plan = planRows.find((p) => p.decision_id === row.id);
    const planSteps = plan ? (byPlan.get(plan.id) ?? []) : [];
    return {
      id: row.id,
      key: row.decision_key,
      module: row.module,
      domain: row.domain,
      title: row.title,
      trigger: row.trigger,
      status: row.status,
      riskLevel: row.risk_level,
      confidence: Number(row.confidence),
      requiresApproval: row.requires_approval,
      criteriaWeights: row.criteria_weights ?? {},
      constraints: row.constraints ?? [],
      options: row.options ?? [],
      recommendedOptionKey: row.recommended_option_key,
      reasoning: row.reasoning ?? {},
      expectedOutcomes: row.expected_outcomes ?? [],
      evidence: row.evidence ?? [],
      assumptions: row.assumptions ?? [],
      uncertainties: row.uncertainties ?? [],
      risks: row.risks ?? [],
      reasoningSources: row.reasoning_sources ?? [],
      predictionKeys: (row.context?.prediction_keys as string[]) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decisionNote: row.decision_note,
      outcome: row.outcome,
      planId: plan?.id ?? null,
      plan: {
        objective: plan?.objective ?? row.title,
        status: plan?.status ?? "draft",
        steps: planSteps.map(stepRow),
      },
      planSteps: planSteps.map((s: any) => ({ id: s.id as string, ...stepRow(s) })),
    } as StoredDecision;
  });
}

export async function getRestaurantDecisionBoard(
  sb: Sb,
  userId: string,
  input: RestaurantDecisionBoardInput,
): Promise<RestaurantDecisionBoard> {
  const { tenantId, windowDays } = input;
  await assertTenantRead(sb, userId, tenantId);
  const { findings, candidates } = await evaluate(sb, userId, tenantId, windowDays);

  return {
    generated_at: new Date().toISOString(),
    tenant_id: tenantId,
    window_days: windowDays,
    headline: restaurantDecisionHeadline(candidates),
    findings,
    candidates,
    stored: input.includeStored === false ? [] : await loadStored(sb, tenantId),
  };
}

/**
 * Persist evaluated decisions and their plans. Idempotent per decision key, so
 * re-running a pass never duplicates an open decision.
 */
export async function runRestaurantDecisionPass(
  sb: Sb,
  userId: string,
  input: RunRestaurantDecisionPassInput,
): Promise<RestaurantDecisionPassResult> {
  const { tenantId, windowDays } = input;
  await assertCapability(sb, userId, tenantId, "intelligence.read");
  const { findings, candidates } = await evaluate(sb, userId, tenantId, windowDays);

  const result: RestaurantDecisionPassResult = {
    findings: findings.length,
    decisionsEvaluated: candidates.length,
    decisionsRecorded: 0,
    plansCreated: 0,
    headline: restaurantDecisionHeadline(candidates),
  };
  if (input.persist === false) return result;

  for (const { finding, decision: d } of candidates) {
    const { data: existing } = await sb
      .from("intelligence_decisions")
      .select("id")
      .eq("module", "restaurant")
      .eq("decision_key", d.key)
      .maybeSingle();
    if (existing) continue;

    const { data: row, error } = await sb
      .from("intelligence_decisions")
      .insert({
        module: "restaurant",
        domain: d.domain,
        decision_key: d.key,
        title: d.title,
        trigger: d.trigger,
        status: "proposed",
        risk_level: d.riskLevel,
        confidence: d.confidence,
        requires_approval: d.requiresApproval,
        recommended_option_key: d.recommendedOptionKey,
        options: d.options,
        criteria_weights: d.criteriaWeights,
        constraints: d.constraints,
        reasoning: d.reasoning,
        expected_outcomes: d.expectedOutcomes,
        evidence: d.evidence,
        assumptions: d.assumptions,
        uncertainties: d.uncertainties,
        risks: d.risks,
        reasoning_sources: d.reasoningSources,
        context: {
          tenant_id: tenantId,
          window_days: windowDays,
          finding,
          prediction_keys: d.predictionKeys,
        },
      })
      .select("id")
      .single();
    if (error || !row) continue;
    result.decisionsRecorded += 1;

    const { data: plan } = await sb
      .from("intelligence_plans")
      .insert({ decision_id: row.id, objective: d.plan.objective, status: "draft" })
      .select("id")
      .single();
    if (!plan) continue;
    result.plansCreated += 1;

    await sb.from("intelligence_plan_steps").insert(
      d.plan.steps.map((s) => ({
        plan_id: plan.id,
        sequence: s.sequence,
        title: s.title,
        objective: s.objective,
        module: s.module,
        responsible_role: s.responsibleRole,
        depends_on: s.dependsOn,
        requires_approval: s.requiresApproval,
        expected_outcome: s.expectedOutcome,
      })),
    );
  }

  return result;
}