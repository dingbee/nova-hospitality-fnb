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
  RestaurantActionSummary,
  RestaurantDecisionBoard,
  RestaurantDecisionBoardInput,
  RestaurantDecisionPassResult,
  RestaurantFinding,
  RestaurantStoredDecision,
  RunRestaurantDecisionPassInput,
} from "./decision.types";

type Sb = any;

/**
 * I10 — the deterministic "did this change become important enough to
 * surface" signal. A canonical string of exactly the two things that make a
 * finding materially different from what a manager already saw: its
 * severity, and its facts (the structured, entity-specific numbers/flags
 * gatherFindings already computes — reorder point breach, margin percent,
 * recommended quantity, and so on). No AI, no new scoring model: this reuses
 * the same facts the option catalogue itself already scores against.
 *
 * Deliberately excludes headline/detail/evidence copy and the prediction
 * block — those are derived, human-readable restatements of the same facts
 * and can reflow (wording, rounding, a recomputed 30-day projection) without
 * the underlying situation having materially changed. Comparing on facts +
 * severity avoids treating cosmetic churn as a reason to re-surface a
 * decision a manager has not even looked at yet.
 */
function findingFingerprint(
  f: Pick<RestaurantFinding, "severity" | "facts"> | null | undefined,
): string {
  if (!f) return "";
  const sortedFacts: Record<string, unknown> = {};
  for (const k of Object.keys(f.facts ?? {}).sort()) sortedFacts[k] = (f.facts as any)[k];
  return JSON.stringify({ severity: f.severity, facts: sortedFacts });
}

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
async function loadStored(sb: Sb, tenantId: string): Promise<RestaurantStoredDecision[]> {
  const { data } = await sb
    .from("intelligence_decisions")
    .select("*")
    .eq("module", "restaurant")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(25);
  const rows = (data ?? []) as any[];
  if (rows.length === 0) return [];

  // I11 — the owning action's own live status, batch-fetched the same way
  // plans/plan_steps already are, so the UI can show real Executed/Verified/
  // Failed state rather than only a moment-of-click toast. Read-only: never
  // mutates intelligence_actions.
  const actionIds = rows.map((r) => r.action_id).filter((id): id is string => Boolean(id));
  const { data: actionRows } = actionIds.length
    ? await sb
        .from("intelligence_actions")
        .select("id, status, failure_reason, verification_result")
        .in("id", actionIds)
    : { data: [] as any[] };
  const actionById = new Map<string, RestaurantActionSummary>(
    ((actionRows ?? []) as any[]).map((a) => [
      a.id,
      {
        id: a.id,
        status: a.status,
        failureReason: a.failure_reason ?? null,
        verified: a.verification_result?.verified ?? null,
        verificationOutcome: a.verification_result?.outcome ?? null,
      },
    ]),
  );

  const { data: plans } = await sb
    .from("intelligence_plans")
    .select("id, decision_id, objective, status")
    .in(
      "decision_id",
      rows.map((r) => r.id),
    );
  const planRows = (plans ?? []) as any[];

  const { data: steps } = planRows.length
    ? await sb
        .from("intelligence_plan_steps")
        .select("*")
        .in(
          "plan_id",
          planRows.map((p) => p.id),
        )
        .order("sequence", { ascending: true })
    : { data: [] as any[] };

  const byPlan = new Map<string, any[]>();
  for (const s of (steps ?? []) as any[])
    byPlan.set(s.plan_id, [...(byPlan.get(s.plan_id) ?? []), s]);

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
      actionId: row.action_id ?? null,
      planId: plan?.id ?? null,
      plan: {
        objective: plan?.objective ?? row.title,
        status: plan?.status ?? "draft",
        steps: planSteps.map(stepRow),
      },
      planSteps: planSteps.map((s: any) => ({ id: s.id as string, ...stepRow(s) })),
      action: row.action_id ? (actionById.get(row.action_id) ?? null) : null,
    } as RestaurantStoredDecision;
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
 *
 * I10 — this is the same function, extended with the smallest correct
 * reconciliation step (see the accompanying I10 architecture note):
 *
 *   - A finding with no existing decision → insert (unchanged behavior).
 *   - A finding whose decision already exists and is still `proposed`
 *     (nobody has reviewed it yet) → refresh that SAME row in place only if
 *     the finding materially changed (findingFingerprint), so a manager who
 *     opens it later sees current evidence. The decision_key, and therefore
 *     its identity, never changes.
 *   - A finding whose decision already exists and has moved past `proposed`
 *     (approved/rejected/modified/executing/completed/failed) → left
 *     completely untouched, forever. That record belongs to the human who
 *     acted on it; I10 has no authority to touch it, no matter how the
 *     finding since changed.
 *   - A `proposed` decision whose finding no longer appears in this pass's
 *     candidates at all → marked `expired` (a status this schema has always
 *     allowed but nothing previously set). The row and its full evidence
 *     stay in place — nothing is deleted, nothing is silently hidden.
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
    decisionsUpdated: 0,
    decisionsExpired: 0,
    plansCreated: 0,
    headline: restaurantDecisionHeadline(candidates),
  };
  if (input.persist === false) return result;

  const currentDecisionKeys = new Set(candidates.map((c) => c.decision.key));

  for (const { finding, decision: d } of candidates) {
    const { data: existing } = await sb
      .from("intelligence_decisions")
      .select("id, status, context")
      .eq("module", "restaurant")
      .eq("tenant_id", tenantId)
      .eq("decision_key", d.key)
      .maybeSingle();

    if (existing) {
      // I10 reconciliation — see the file/function doc comment. Only a
      // still-`proposed` decision is ever touched.
      if (existing.status === "proposed") {
        const previousFinding = existing.context?.finding as RestaurantFinding | undefined;
        const changed = findingFingerprint(finding) !== findingFingerprint(previousFinding);
        if (changed) {
          const { error: updateError } = await sb
            .from("intelligence_decisions")
            .update({
              title: d.title,
              trigger: d.trigger,
              risk_level: d.riskLevel,
              confidence: d.confidence,
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
            .eq("id", existing.id)
            // Defensive re-check: if a human reviewed this decision between
            // the select above and this update, the row no longer matches
            // and zero rows are affected — the human's action wins.
            .eq("status", "proposed");
          if (!updateError) result.decisionsUpdated += 1;
        }
      }
      continue;
    }

    const { data: row, error } = await sb
      .from("intelligence_decisions")
      .insert({
        tenant_id: tenantId,
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

  // I10 resolution sweep — a `proposed` decision whose finding is no longer
  // among this pass's candidates means the condition it was raised for is
  // no longer current (e.g. a shortage was replenished). Mark it `expired`,
  // never delete it, and never touch anything a human has already reviewed.
  const { data: openRows } = await sb
    .from("intelligence_decisions")
    .select("id, decision_key")
    .eq("module", "restaurant")
    .eq("tenant_id", tenantId)
    .eq("status", "proposed");
  for (const row of (openRows ?? []) as Array<{ id: string; decision_key: string }>) {
    if (currentDecisionKeys.has(row.decision_key)) continue;
    const { error: expireError } = await sb
      .from("intelligence_decisions")
      .update({ status: "expired" })
      .eq("id", row.id)
      // Same defensive re-check as the update path above — a decision a
      // human reviewed in the meantime is left exactly as they left it.
      .eq("status", "proposed");
    if (!expireError) result.decisionsExpired += 1;
  }

  return result;
}
