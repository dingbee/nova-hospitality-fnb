/**
 * Phase 4 — Restaurant decision engine.
 *
 * Reuses the Intelligence Core evaluator and planner unchanged, so restaurant
 * decisions are scored, constrained, planned, approved and learned from
 * exactly like revenue or operations decisions. Pure: no Supabase, no AI.
 */
import { buildPlan } from "@/modules/intelligence/decisions/planningEngine";
import {
  decisionConfidence,
  evaluateOptions,
  explainRanking,
} from "@/modules/intelligence/decisions/optionEvaluator";
import { weightsFor } from "@/modules/intelligence/decisions/decisionRules";
import type { Decision, EvaluatedOption } from "@/modules/intelligence/decisions/decision.types";
import type { RestaurantDecisionCandidate, RestaurantFinding } from "./decision.types";
import { DOMAIN_FOR_KIND, constraintsFor, optionsFor } from "./optionCatalogue";

const TITLE: Record<RestaurantFinding["kind"], (f: RestaurantFinding) => string> = {
  menu_margin: (f) => `How should we respond to the margin position on ${f.subject}?`,
  inventory_shortage: (f) => `How should we cover the forecast ${f.subject} shortage?`,
  wastage_spike: () => "How should we respond to the rise in wastage?",
  kitchen_capacity: (f) => `How should we relieve pressure on ${f.subject}?`,
  purchasing_replenishment: (f) => `How should we replenish ${f.subject}?`,
  supplier_risk: (f) => `How should we respond to the supplier price move on ${f.subject}?`,
};

function riskLevelFor(
  finding: RestaurantFinding,
  ranked: EvaluatedOption[],
  confidence: number,
): Decision["riskLevel"] {
  if (ranked.every((o) => o.excluded)) return "critical";
  if (finding.severity === "critical") return "critical";
  if (finding.severity === "high") return confidence >= 0.7 ? "high" : "medium";
  if (confidence < 0.5) return "medium";
  return finding.severity === "medium" ? "medium" : "low";
}

/** One finding → one fully evaluated, planned decision. */
export function buildRestaurantDecision(finding: RestaurantFinding, tenantId: string): Decision {
  const domain = DOMAIN_FOR_KIND[finding.kind];
  const constraints = constraintsFor(finding);
  const weights = weightsFor(domain);
  const ranked = evaluateOptions(optionsFor(finding), weights, constraints);
  const top = ranked.find((o) => !o.excluded) ?? null;
  const confidence = decisionConfidence(ranked, finding.prediction.confidence);
  const riskLevel = riskLevelFor(finding, ranked, confidence);

  const reasoning = {
    whatIsHappening: finding.headline,
    whyItMatters: finding.detail,
    whatIsLikely: finding.prediction.statement,
    optionsConsidered: ranked.map(
      (o) =>
        `${o.rank}. ${o.option.title} — score ${Math.round(o.finalScore * 100)}${o.excluded ? " (excluded)" : ""}`,
    ),
    tradeOffs: ranked
      .slice(0, 4)
      .map(
        (o) =>
          `${o.option.title}: ${[...o.strengths, ...o.tradeOffs].join("; ") || "balanced across all criteria"}`,
      ),
    selectedOption: top?.option.title ?? "No option satisfied the active constraints",
    whySelected: explainRanking(ranked),
    whatCouldGoWrong: risksFor(finding),
    whatHappensNext: top
      ? top.option.tactics
      : ["Escalate to the general manager — every option breached a constraint."],
  };

  const plan = buildPlan({
    domain,
    module: "restaurant",
    top,
    horizonDays: finding.prediction.horizonDays,
  });

  return {
    key: `restaurant.${tenantId}.${finding.key}`,
    module: "restaurant",
    domain,
    title: TITLE[finding.kind](finding),
    trigger: finding.headline,
    status: "proposed",
    riskLevel,
    confidence,
    requiresApproval: true,
    criteriaWeights: weights,
    constraints,
    options: ranked,
    recommendedOptionKey: top?.option.key ?? null,
    reasoning,
    expectedOutcomes: top
      ? [
          `${top.option.title} is executed within ${finding.prediction.horizonDays} days`,
          `${finding.subject}: ${finding.prediction.statement}`,
          "Result recorded against the prediction so the loop can learn",
        ]
      : ["No expected outcome — no acceptable option."],
    evidence: [{ label: "Finding", value: finding.headline }, ...finding.evidence],
    assumptions: assumptionsFor(finding),
    uncertainties: [
      "Consumption and sales velocity are assumed to continue at the observed rate",
      "Supplier prices and lead times are taken from the last recorded values",
    ],
    risks: risksFor(finding),
    reasoningSources: ["restaurant_intelligence", "restaurant_decision_engine"],
    predictionKeys: [finding.prediction.key],
    plan,
  };
}

function assumptionsFor(f: RestaurantFinding): string[] {
  switch (f.kind) {
    case "menu_margin":
      return [
        "Recipe costing reflects the current specification",
        "Sales mix stays broadly stable over the next window",
      ];
    case "inventory_shortage":
    case "purchasing_replenishment":
      return [
        "Consumption continues at the observed daily velocity",
        "Supplier lead times hold at the recorded values",
      ];
    case "wastage_spike":
      return ["Wastage is being logged consistently through the stock ledger"];
    case "kitchen_capacity":
      return ["Ticket timestamps are captured accurately", "Covers at dinner peak stay at current levels"];
    case "supplier_risk":
      return ["The quoted price is current and applies to our normal order volume"];
  }
}

function risksFor(f: RestaurantFinding): string[] {
  switch (f.kind) {
    case "menu_margin":
      return [
        "A price or recipe change is visible to returning guests",
        "Cutting a component can reduce perceived value more than it saves",
      ];
    case "inventory_shortage":
      return [
        "Emergency purchasing usually costs more per unit than planned ordering",
        "Marking dishes unavailable at service is visible to guests",
      ];
    case "wastage_spike":
      return ["Tightening pars too far causes stockouts during service"];
    case "kitchen_capacity":
      return [
        "Added labour raises cost without guaranteed throughput gain",
        "Simplifying the menu narrows the guest offer",
      ];
    case "purchasing_replenishment":
    case "supplier_risk":
      return [
        "Switching supplier can change product specification and consistency",
        "Delaying the order risks a stockout inside the lead time",
      ];
  }
}

export function buildRestaurantDecisions(
  findings: RestaurantFinding[],
  tenantId: string,
): RestaurantDecisionCandidate[] {
  return findings
    .map((finding) => ({ finding, decision: buildRestaurantDecision(finding, tenantId) }))
    .sort((a, b) => b.decision.confidence - a.decision.confidence);
}

export function restaurantDecisionHeadline(candidates: RestaurantDecisionCandidate[]): string {
  if (candidates.length === 0) return "No restaurant decisions require attention right now.";
  const top = candidates[0].decision;
  const rec = top.options.find((o) => o.option.key === top.recommendedOptionKey);
  return `${top.title} → ${rec?.option.title ?? "no acceptable option"} (confidence ${Math.round(top.confidence * 100)}%, risk ${top.riskLevel}).`;
}