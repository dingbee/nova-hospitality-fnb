/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 5 — Decision & Planning persistence and governance.
 *
 * The engine (decisionEngine.ts) is pure. This file reads the context and
 * predictions the earlier sprints already produce, persists decisions and
 * plans, enforces approval, and feeds outcomes back into feedback and memory.
 *
 * The Intelligence Core still never mutates another module's data.
 */
import { assertIntelDecide, assertIntelRead, visibleModules } from "../core/access.server";
import { gatherForecasts } from "../predictions/forecast.server";
import { buildDecisions, decisionHeadline } from "./decisionEngine";
import type {
  Decision,
  DecisionBoard,
  DecideDecisionInput,
  PlanStep,
  RunDecisionPassResult,
  StoredDecision,
  UpdatePlanStepInput,
} from "./decision.types";

type Sb = any;

function rowToStored(row: any, steps: any[]): StoredDecision {
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
    planId: steps[0]?.plan_id ?? null,
    plan: {
      objective: row.reasoning?.selectedOption ?? row.title,
      status: "draft",
      steps: steps.map(stepRow),
    },
    planSteps: steps.map((s) => ({ id: s.id as string, ...stepRow(s) })),
  };
}

function stepRow(s: any): PlanStep {
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

async function loadStored(supabase: Sb, modules: string[]): Promise<StoredDecision[]> {
  const { data: decisions } = await supabase
    .from("intelligence_decisions")
    .select("*")
    .in("module", modules)
    .order("created_at", { ascending: false })
    .limit(25);
  const rows = (decisions ?? []) as any[];
  if (rows.length === 0) return [];

  const { data: plans } = await supabase
    .from("intelligence_plans")
    .select("id, decision_id, objective, status")
    .in("decision_id", rows.map((r) => r.id));
  const planRows = (plans ?? []) as any[];

  const { data: steps } = planRows.length
    ? await supabase
        .from("intelligence_plan_steps")
        .select("*")
        .in("plan_id", planRows.map((p) => p.id))
        .order("sequence", { ascending: true })
    : { data: [] as any[] };

  const stepsByPlan = new Map<string, any[]>();
  for (const s of (steps ?? []) as any[]) {
    stepsByPlan.set(s.plan_id, [...(stepsByPlan.get(s.plan_id) ?? []), s]);
  }

  return rows.map((r) => {
    const plan = planRows.find((p) => p.decision_id === r.id);
    const stored = rowToStored(r, plan ? (stepsByPlan.get(plan.id) ?? []) : []);
    if (plan) {
      stored.planId = plan.id;
      stored.plan.objective = plan.objective;
      stored.plan.status = plan.status;
    }
    return stored;
  });
}

/** Read-only board: freshly evaluated decisions plus everything persisted. */
export async function getDecisionBoard(
  supabase: Sb,
  userId: string,
  input: { horizonDays?: number; includeStored?: boolean } = {},
): Promise<DecisionBoard> {
  await assertIntelRead(supabase, userId);
  const horizonDays = input.horizonDays ?? 14;
  const allowed = await visibleModules(supabase, userId);
  const { ctx, forecasts } = await gatherForecasts(supabase, userId, horizonDays);
  const decisions = buildDecisions(ctx, forecasts).filter((d) => allowed.includes(d.module));
  const stored = input.includeStored === false ? [] : await loadStored(supabase, allowed);

  return {
    generated_at: new Date().toISOString(),
    horizon_days: horizonDays,
    headline: decisionHeadline(decisions),
    decisions,
    stored,
  };
}

/** Optional LLM narration — never replaces the deterministic scoring. */
async function narrate(decision: Decision): Promise<string | null> {
  try {
    const { callAiGateway } = await import("@/lib/ai-gateway.server");
    const { content } = await callAiGateway({
      system:
        "You are an operations analyst at a Tanzanian river lodge. Explain a decision that has ALREADY been made by a deterministic scoring engine. Do not change the ranking, do not invent numbers. Three short sentences, plain English, no bullet points.",
      user: JSON.stringify({
        situation: decision.reasoning.whatIsHappening,
        likely: decision.reasoning.whatIsLikely,
        selected: decision.reasoning.selectedOption,
        why: decision.reasoning.whySelected,
        risks: decision.risks,
      }),
    });
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Evaluate and persist decisions plus their plans. Idempotent per decision key
 * (module, decision_key is unique), so re-running the pass never duplicates.
 */
export async function runDecisionPass(
  supabase: Sb,
  userId: string,
  input: { horizonDays?: number; persist?: boolean } = {},
): Promise<RunDecisionPassResult> {
  await assertIntelRead(supabase, userId);
  const horizonDays = input.horizonDays ?? 14;
  const persist = input.persist ?? true;
  const allowed = await visibleModules(supabase, userId);
  const { ctx, forecasts } = await gatherForecasts(supabase, userId, horizonDays);
  const decisions = buildDecisions(ctx, forecasts).filter((d) => allowed.includes(d.module));

  const result: RunDecisionPassResult = {
    decisionsEvaluated: decisions.length,
    decisionsRecorded: 0,
    plansCreated: 0,
    headline: decisionHeadline(decisions),
  };
  if (!persist) return result;

  for (const d of decisions) {
    const { data: existing } = await supabase
      .from("intelligence_decisions")
      .select("id")
      .eq("module", d.module)
      .eq("decision_key", d.key)
      .maybeSingle();
    if (existing) continue;

    const narrative = await narrate(d);
    const { data: row, error } = await supabase
      .from("intelligence_decisions")
      .insert({
        module: d.module,
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
        reasoning: narrative ? { ...d.reasoning, narrative } : d.reasoning,
        expected_outcomes: d.expectedOutcomes,
        evidence: d.evidence,
        assumptions: d.assumptions,
        uncertainties: d.uncertainties,
        risks: d.risks,
        reasoning_sources: d.reasoningSources,
        context: { business_context: ctx, prediction_keys: d.predictionKeys },
      })
      .select("id")
      .single();
    if (error || !row) continue;
    result.decisionsRecorded += 1;

    const { data: plan } = await supabase
      .from("intelligence_plans")
      .insert({ decision_id: row.id, objective: d.plan.objective, status: "draft" })
      .select("id")
      .single();
    if (!plan) continue;
    result.plansCreated += 1;

    await supabase.from("intelligence_plan_steps").insert(
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

/**
 * Governance: approve, reject, modify or close a decision. Approval creates an
 * action proposal in the existing ledger — the owning module still executes it.
 * Completing or failing a decision writes feedback and an observed memory.
 */
export async function decideDecision(supabase: Sb, userId: string, input: DecideDecisionInput) {
  await assertIntelDecide(supabase, userId);

  const { data: row, error: loadError } = await supabase
    .from("intelligence_decisions")
    .select("*")
    .eq("id", input.id)
    .single();
  if (loadError || !row) throw new Error(loadError?.message ?? "Decision not found.");

  const now = new Date().toISOString();
  const selectedKey = input.selectedOptionKey ?? row.recommended_option_key;
  const patch: Record<string, unknown> = {
    status: input.decision,
    decided_by: userId,
    decided_at: now,
    decision_note: input.note ?? row.decision_note ?? null,
    recommended_option_key: selectedKey,
  };
  if (input.outcomeSummary) {
    patch.outcome = { summary: input.outcomeSummary, recorded_at: now, recorded_by: userId };
  }

  const { error } = await supabase.from("intelligence_decisions").update(patch).eq("id", input.id);
  if (error) throw new Error(error.message);

  const selected = ((row.options ?? []) as any[]).find((o) => o?.option?.key === selectedKey);
  let actionId: string | null = row.action_id ?? null;

  if (input.decision === "approved" || input.decision === "modified") {
    await supabase
      .from("intelligence_plans")
      .update({ status: "approved" })
      .eq("decision_id", input.id);

    if (!actionId && selected) {
      const { data: action } = await supabase
        .from("intelligence_actions")
        .insert({
          module: row.module,
          action_type: selected.option.actionType,
          title: `${row.title} → ${selected.option.title}`,
          payload: {
            decision_id: row.id,
            decision_key: row.decision_key,
            option_key: selected.option.key,
            tactics: selected.option.tactics,
          },
          automated: false,
          requires_approval: true,
          dedupe_key: `decision:${row.id}`,
          requested_by: userId,
          status: "approved",
          approved_by: userId,
          approved_at: now,
        })
        .select("id")
        .single();
      if (action) {
        actionId = action.id as string;
        await supabase.from("intelligence_decisions").update({ action_id: actionId }).eq("id", input.id);
      }
    }
  }

  if (input.decision === "rejected") {
    await supabase.from("intelligence_plans").update({ status: "cancelled" }).eq("decision_id", input.id);
  }
  if (input.decision === "executing") {
    await supabase.from("intelligence_plans").update({ status: "in_progress" }).eq("decision_id", input.id);
  }
  if (input.decision === "completed") {
    await supabase.from("intelligence_plans").update({ status: "completed" }).eq("decision_id", input.id);
  }

  /* ---- Learn: feedback always, memory only for closed outcomes ---- */
  await supabase.from("intelligence_feedback").insert({
    subject_type: "recommendation",
    subject_id: row.id,
    module: row.module,
    stage: "act",
    useful: input.decision === "approved" || input.decision === "completed",
    comment: `Decision ${input.decision}${selectedKey ? ` — option ${selectedKey}` : ""}${input.note ? `: ${input.note}` : ""}`,
    correction: input.decision === "rejected" ? (input.note ?? null) : null,
    created_by: userId,
  });

  if (input.decision === "completed" || input.decision === "failed") {
    const { remember } = await import("../memory/memory.server");
    // Observed tier only — promotion to learned/strategic stays human-curated.
    await remember(supabase, userId, {
      scope: "property",
      module: row.module,
      memoryKey: `decision_outcome.${row.domain}.${selectedKey ?? "none"}`,
      memoryValue:
        input.outcomeSummary ??
        `${row.title}: "${selected?.option?.title ?? selectedKey ?? "selected option"}" ${input.decision === "completed" ? "was executed and closed" : "failed during execution"}.`,
      memoryType: "outcome",
      memoryTier: "observed",
      confidence: input.decision === "completed" ? 0.6 : 0.4,
      source: "decision_engine",
      metadata: { decision_id: row.id, decision_key: row.decision_key, status: input.decision },
    } as any);
  }

  return { ok: true as const, actionId };
}

/** Plan step progress — any staff member may move a step they are working on. */
export async function updatePlanStep(supabase: Sb, userId: string, input: UpdatePlanStepInput) {
  await assertIntelRead(supabase, userId);
  const patch: Record<string, unknown> = { status: input.status };
  if (input.note) patch.note = input.note;
  if (input.status === "done") patch.completed_at = new Date().toISOString();
  const { error } = await supabase.from("intelligence_plan_steps").update(patch).eq("id", input.stepId);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}