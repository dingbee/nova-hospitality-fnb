/**
 * Sprint 5 — Decision & Planning Intelligence (browser-safe contracts).
 *
 *   Context + Prediction + Memory + Options + Constraints
 *                       ↓
 *        Evaluate → Decide → Plan → Approve → Act → Learn
 *
 * Everything here is data only: no Supabase, no AI calls. The scoring maths
 * lives in optionEvaluator.ts and stays fully inspectable.
 */
import { z } from "zod";

export const DECISION_DOMAINS = [
  "revenue",
  "demand",
  "operations",
  "guest_experience",
  "marketing",
] as const;
export type DecisionDomain = (typeof DECISION_DOMAINS)[number];

export const DECISION_DOMAIN_LABEL: Record<DecisionDomain, string> = {
  revenue: "Revenue",
  demand: "Demand",
  operations: "Operations",
  guest_experience: "Guest experience",
  marketing: "Marketing",
};

export const DECISION_CRITERIA = [
  "expected_revenue",
  "occupancy_impact",
  "margin_impact",
  "guest_experience",
  "strategic_alignment",
  "operational_feasibility",
  "risk",
  "historical_evidence",
] as const;
export type DecisionCriterion = (typeof DECISION_CRITERIA)[number];

export const DECISION_CRITERION_LABEL: Record<DecisionCriterion, string> = {
  expected_revenue: "Expected revenue",
  occupancy_impact: "Occupancy impact",
  margin_impact: "Margin impact",
  guest_experience: "Guest experience",
  strategic_alignment: "Strategic alignment",
  operational_feasibility: "Operational feasibility",
  risk: "Risk (higher = safer)",
  historical_evidence: "Historical evidence",
};

export type CriteriaWeights = Partial<Record<DecisionCriterion, number>>;

/** A candidate response to a business situation, before evaluation. */
export interface DecisionOption {
  key: string;
  title: string;
  summary: string;
  /** Action type the owning module would execute if this option is chosen. */
  actionType: string;
  /** Concrete tactics — these become plan steps. */
  tactics: string[];
  /** Criterion → 0..1 score. Missing criteria are treated as neutral (0.5). */
  scores: CriteriaWeights;
  /** Constraint keys this option touches, used by the constraint engine. */
  tags: string[];
  /** Operational cost hint used in trade-off narration. */
  effort: "low" | "medium" | "high";
}

export type ConstraintEffect = "exclude" | "penalise";

/** A rule that limits which options are acceptable. */
export interface DecisionConstraint {
  key: string;
  label: string;
  /** Where the constraint came from: strategic memory, capacity, policy. */
  source: "strategic_memory" | "capacity" | "policy" | "availability" | "approval";
  description: string;
  effect: ConstraintEffect;
  /** 0..1 score deduction applied when an option violates the constraint. */
  penalty: number;
  /** Option tags that violate this constraint. */
  violatedByTags: string[];
}

export interface CriterionScore {
  criterion: DecisionCriterion;
  label: string;
  weight: number;
  score: number;
  contribution: number;
}

export interface AppliedPenalty {
  constraintKey: string;
  label: string;
  reason: string;
  penalty: number;
}

export interface EvaluatedOption {
  option: DecisionOption;
  criteria: CriterionScore[];
  penalties: AppliedPenalty[];
  /** Weighted sum before constraint penalties, 0..1. */
  rawScore: number;
  penalty: number;
  /** rawScore - penalty, clamped to 0..1. */
  finalScore: number;
  rank: number;
  excluded: boolean;
  exclusionReason: string | null;
  /** Manager-readable strengths and weaknesses. */
  strengths: string[];
  tradeOffs: string[];
}

export interface DecisionReasoning {
  whatIsHappening: string;
  whyItMatters: string;
  whatIsLikely: string;
  optionsConsidered: string[];
  tradeOffs: string[];
  selectedOption: string;
  whySelected: string;
  whatCouldGoWrong: string[];
  whatHappensNext: string[];
  /** Optional LLM narration; deterministic scoring is never replaced by it. */
  narrative?: string;
}

export interface PlanStep {
  sequence: number;
  title: string;
  objective: string;
  module: string;
  responsibleRole: string;
  dependsOn: number | null;
  requiresApproval: boolean;
  expectedOutcome: string;
  status: PlanStepStatus;
}

export const PLAN_STEP_STATUSES = ["pending", "blocked", "in_progress", "done", "skipped"] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export interface DecisionPlan {
  objective: string;
  status: "draft" | "approved" | "in_progress" | "completed" | "cancelled";
  steps: PlanStep[];
}

export const DECISION_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "modified",
  "executing",
  "completed",
  "failed",
  "expired",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface DecisionEvidence {
  label: string;
  value: string;
}

export interface DecisionOutcome {
  summary: string;
  recorded_at: string;
  recorded_by: string;
}

/** The full decision record. Persisted to intelligence_decisions. */
export interface Decision {
  id?: string;
  key: string;
  module: string;
  domain: DecisionDomain;
  title: string;
  trigger: string;
  status: DecisionStatus;
  riskLevel: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;
  requiresApproval: boolean;
  criteriaWeights: CriteriaWeights;
  constraints: DecisionConstraint[];
  options: EvaluatedOption[];
  recommendedOptionKey: string | null;
  reasoning: DecisionReasoning;
  expectedOutcomes: string[];
  evidence: DecisionEvidence[];
  assumptions: string[];
  uncertainties: string[];
  risks: string[];
  reasoningSources: string[];
  predictionKeys: string[];
  plan: DecisionPlan;
  createdAt?: string;
  updatedAt?: string;
  decisionNote?: string | null;
  outcome?: DecisionOutcome | null;
}

/* ---------------- server-function input schemas ---------------- */

export const decisionBoardSchema = z.object({
  horizonDays: z.number().int().min(7).max(90).default(14),
  /** Include stored decisions alongside freshly evaluated ones. */
  includeStored: z.boolean().default(true),
});
export type DecisionBoardInput = z.infer<typeof decisionBoardSchema>;

export const runDecisionPassSchema = z.object({
  horizonDays: z.number().int().min(7).max(90).default(14),
  persist: z.boolean().default(true),
});
export type RunDecisionPassInput = z.infer<typeof runDecisionPassSchema>;

export const decideDecisionSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approved", "rejected", "modified", "executing", "completed", "failed"]),
  /** Manager may override the engine's pick when approving or modifying. */
  selectedOptionKey: z.string().max(120).optional(),
  note: z.string().max(2000).optional(),
  /** Recorded when completing/failing so the loop can learn. */
  outcomeSummary: z.string().max(2000).optional(),
});
export type DecideDecisionInput = z.infer<typeof decideDecisionSchema>;

export const updatePlanStepSchema = z.object({
  stepId: z.string().uuid(),
  status: z.enum(PLAN_STEP_STATUSES),
  note: z.string().max(1000).optional(),
});
export type UpdatePlanStepInput = z.infer<typeof updatePlanStepSchema>;

export interface StoredDecision extends Decision {
  id: string;
  planId: string | null;
  planSteps: Array<PlanStep & { id: string }>;
}

export interface DecisionBoard {
  generated_at: string;
  horizon_days: number;
  headline: string;
  /** Freshly evaluated decisions (deterministic, not yet persisted). */
  decisions: Decision[];
  /** Persisted decisions with approval state and plan progress. */
  stored: StoredDecision[];
}

export interface RunDecisionPassResult {
  decisionsEvaluated: number;
  decisionsRecorded: number;
  plansCreated: number;
  headline: string;
}