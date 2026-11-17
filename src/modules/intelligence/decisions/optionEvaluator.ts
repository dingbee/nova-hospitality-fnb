/**
 * Sprint 5 — Weighted option evaluation.
 *
 * Deterministic and reproducible: same options + weights + constraints always
 * produce the same ranking. No LLM anywhere in this file.
 */
import {
  DECISION_CRITERION_LABEL,
  type AppliedPenalty,
  type CriteriaWeights,
  type CriterionScore,
  type DecisionConstraint,
  type DecisionCriterion,
  type DecisionOption,
  type EvaluatedOption,
} from "./decision.types";

const NEUTRAL = 0.5;
const round = (n: number, p = 3) => Math.round(n * 10 ** p) / 10 ** p;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Normalise a weight set so contributions always sum to 1. */
export function normaliseWeights(weights: CriteriaWeights): Array<[DecisionCriterion, number]> {
  const entries = (Object.entries(weights) as Array<[DecisionCriterion, number]>).filter(
    ([, w]) => Number.isFinite(w) && w > 0,
  );
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return [];
  return entries
    .map(([c, w]) => [c, round(w / total, 4)] as [DecisionCriterion, number])
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])));
}

function penaltiesFor(option: DecisionOption, constraints: DecisionConstraint[]) {
  const applied: AppliedPenalty[] = [];
  let excluded = false;
  let exclusionReason: string | null = null;

  for (const c of constraints) {
    const hit = c.violatedByTags.find((t) => option.tags.includes(t));
    if (!hit) continue;
    if (c.effect === "exclude") {
      excluded = true;
      exclusionReason = `${c.label}: ${c.description}`;
      applied.push({ constraintKey: c.key, label: c.label, reason: c.description, penalty: 1 });
    } else {
      applied.push({ constraintKey: c.key, label: c.label, reason: c.description, penalty: c.penalty });
    }
  }
  return { applied, excluded, exclusionReason };
}

function narrate(criteria: CriterionScore[]) {
  const sorted = [...criteria].sort((a, b) => b.score - a.score);
  const strengths = sorted
    .filter((c) => c.score >= 0.7)
    .slice(0, 3)
    .map((c) => `${c.label} is strong (${Math.round(c.score * 100)}%)`);
  const tradeOffs = sorted
    .filter((c) => c.score <= 0.45)
    .slice(-3)
    .map((c) => `${c.label} is weak (${Math.round(c.score * 100)}%)`);
  return { strengths, tradeOffs };
}

/**
 * Score every option against the weighted criteria, apply constraint penalties,
 * then rank. Excluded options are kept (with their reason) so the manager can
 * see what was considered and rejected.
 */
export function evaluateOptions(
  options: DecisionOption[],
  weights: CriteriaWeights,
  constraints: DecisionConstraint[] = [],
): EvaluatedOption[] {
  const normalised = normaliseWeights(weights);

  const evaluated = options.map<EvaluatedOption>((option) => {
    const criteria: CriterionScore[] = normalised.map(([criterion, weight]) => {
      const score = clamp01(option.scores[criterion] ?? NEUTRAL);
      return {
        criterion,
        label: DECISION_CRITERION_LABEL[criterion],
        weight,
        score: round(score),
        contribution: round(score * weight, 4),
      };
    });
    const rawScore = round(criteria.reduce((s, c) => s + c.contribution, 0));
    const { applied, excluded, exclusionReason } = penaltiesFor(option, constraints);
    const penalty = round(Math.min(1, applied.reduce((s, p) => s + p.penalty, 0)));
    const finalScore = excluded ? 0 : round(clamp01(rawScore - penalty));
    const { strengths, tradeOffs } = narrate(criteria);

    return {
      option,
      criteria,
      penalties: applied,
      rawScore,
      penalty,
      finalScore,
      rank: 0,
      excluded,
      exclusionReason,
      strengths,
      tradeOffs: excluded ? [exclusionReason ?? "Excluded by constraint", ...tradeOffs] : tradeOffs,
    };
  });

  // Deterministic ordering: score desc, then option key asc as the tie-break.
  evaluated.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return a.option.key.localeCompare(b.option.key);
  });
  evaluated.forEach((o, i) => {
    o.rank = i + 1;
  });
  return evaluated;
}

/** Plain-language explanation of why the top option beat the runner-up. */
export function explainRanking(ranked: EvaluatedOption[]): string {
  const live = ranked.filter((o) => !o.excluded);
  const [first, second] = live;
  if (!first) return "Every option violated a strategic constraint, so no action is recommended.";
  if (!second) return `${first.option.title} was the only option that satisfied the active constraints.`;

  const deltas = first.criteria
    .map((c) => {
      const other = second.criteria.find((x) => x.criterion === c.criterion);
      return { label: c.label, delta: c.contribution - (other?.contribution ?? 0) };
    })
    .filter((d) => d.delta > 0.001)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3);

  const margin = Math.round((first.finalScore - second.finalScore) * 100);
  const because = deltas.length
    ? deltas.map((d) => `${d.label} (+${Math.round(d.delta * 100)} pts)`).join(", ")
    : "a marginally better balance across all criteria";
  const penaltyNote = second.penalties.length
    ? ` ${second.option.title} also carried a ${Math.round(second.penalty * 100)}-point constraint penalty (${second.penalties.map((p) => p.label).join(", ")}).`
    : "";

  return `${first.option.title} scored ${Math.round(first.finalScore * 100)} versus ${Math.round(second.finalScore * 100)} for ${second.option.title} — a ${margin}-point margin driven by ${because}.${penaltyNote}`;
}

/** Confidence in the decision itself: evidence quality × separation of options. */
export function decisionConfidence(ranked: EvaluatedOption[], inputConfidence: number): number {
  const live = ranked.filter((o) => !o.excluded);
  const first = live[0];
  if (!first) return 0.3;
  const margin = first.finalScore - (live[1]?.finalScore ?? 0);
  const separation = Math.min(0.15, margin) / 0.15; // 0..1
  const value = inputConfidence * 0.65 + first.finalScore * 0.2 + separation * 0.15;
  return round(clamp01(Math.min(0.95, value)), 2);
}