/**
 * Sprint 5 — Decision rules.
 *
 * Weight sets and constraint derivation. Pure and inspectable: a manager can
 * read this file and know exactly why an option was penalised or excluded.
 */
import type { BusinessContext } from "../context/context.types";
import type {
  CriteriaWeights,
  DecisionConstraint,
  DecisionDomain,
  EvaluatedOption,
} from "./decision.types";

/**
 * Default criteria weights per decision domain. Weights are relative — the
 * evaluator normalises them — so a property can later override a single value
 * without rebalancing the rest.
 */
export const DOMAIN_WEIGHTS: Record<DecisionDomain, CriteriaWeights> = {
  revenue: {
    expected_revenue: 0.3,
    strategic_alignment: 0.2,
    guest_experience: 0.15,
    operational_feasibility: 0.15,
    risk: 0.1,
    historical_evidence: 0.1,
  },
  demand: {
    occupancy_impact: 0.3,
    expected_revenue: 0.2,
    strategic_alignment: 0.15,
    operational_feasibility: 0.15,
    risk: 0.1,
    historical_evidence: 0.1,
  },
  operations: {
    operational_feasibility: 0.35,
    guest_experience: 0.25,
    risk: 0.2,
    margin_impact: 0.1,
    historical_evidence: 0.1,
  },
  guest_experience: {
    guest_experience: 0.35,
    strategic_alignment: 0.2,
    operational_feasibility: 0.2,
    expected_revenue: 0.15,
    risk: 0.1,
  },
  marketing: {
    expected_revenue: 0.25,
    occupancy_impact: 0.25,
    margin_impact: 0.15,
    strategic_alignment: 0.15,
    operational_feasibility: 0.1,
    historical_evidence: 0.1,
  },
};

/** Weights for a domain, with optional per-property overrides applied. */
export function weightsFor(domain: DecisionDomain, overrides?: CriteriaWeights): CriteriaWeights {
  return { ...DOMAIN_WEIGHTS[domain], ...(overrides ?? {}) };
}

const DISCOUNT_RE = /discount|rate integrity|no promo|premium positioning|undercut/i;
const CHANNEL_RE = /ota|direct|commission/i;
const SERVICE_RE = /service|personal|experience|hospitality/i;

/**
 * Derive the live constraint set from strategic memory, operational capacity
 * and standing business policy. Strategic memory always wins over tactics.
 */
export function deriveConstraints(ctx: BusinessContext, extra: DecisionConstraint[] = []): DecisionConstraint[] {
  const constraints: DecisionConstraint[] = [];

  for (const m of ctx.memory.strategic) {
    const text = `${m.key} ${m.value}`;
    if (DISCOUNT_RE.test(text)) {
      constraints.push({
        key: "strategic.no_broad_discounting",
        label: "Premium positioning",
        source: "strategic_memory",
        description: `Management preference: ${m.value}`,
        effect: "exclude",
        penalty: 1,
        violatedByTags: ["broad_discount"],
      });
    } else if (CHANNEL_RE.test(text)) {
      constraints.push({
        key: "strategic.direct_first",
        label: "Direct-channel first",
        source: "strategic_memory",
        description: `Management preference: ${m.value}`,
        effect: "penalise",
        penalty: 0.12,
        violatedByTags: ["ota_push"],
      });
    } else if (SERVICE_RE.test(text)) {
      constraints.push({
        key: "strategic.service_standard",
        label: "Service standard",
        source: "strategic_memory",
        description: `Management preference: ${m.value}`,
        effect: "penalise",
        penalty: 0.1,
        violatedByTags: ["service_reduction"],
      });
    }
  }

  // Operational capacity: when occupancy is already tight, options that add
  // significant operational load are penalised rather than excluded.
  if (ctx.occupancy.forecast >= 80) {
    constraints.push({
      key: "capacity.high_occupancy_load",
      label: "Operational capacity",
      source: "capacity",
      description: `Forecast occupancy is ${ctx.occupancy.forecast}% — the team has limited spare capacity.`,
      effect: "penalise",
      penalty: 0.08,
      violatedByTags: ["high_ops_load"],
    });
  }

  // Availability: pushing more demand into an almost-full house is wasted spend.
  if (ctx.occupancy.forecast >= 92) {
    constraints.push({
      key: "availability.inventory_thin",
      label: "Inventory availability",
      source: "availability",
      description: `Only ~${Math.max(0, 100 - ctx.occupancy.forecast)}% of rooms remain unsold in the window.`,
      effect: "penalise",
      penalty: 0.15,
      violatedByTags: ["demand_generation"],
    });
  }

  // Standing pricing policy: never move rate by more than one band at a time.
  constraints.push({
    key: "policy.rate_move_band",
    label: "Pricing policy",
    source: "policy",
    description: "Rate changes are capped at one band per review cycle.",
    effect: "penalise",
    penalty: 0.1,
    violatedByTags: ["aggressive_rate_move"],
  });

  return [...constraints, ...extra];
}

/** Impact-based approval rule: everything material needs a human decision. */
export function requiresApprovalFor(domain: DecisionDomain, top: EvaluatedOption | undefined): boolean {
  if (!top) return true;
  if (domain === "revenue" || domain === "marketing") return true;
  if (top.option.effort === "high") return true;
  return top.penalties.length > 0 || top.finalScore < 0.7;
}

/** Risk level from the winning margin, confidence and outstanding penalties. */
export function riskLevelFor(
  ranked: EvaluatedOption[],
  confidence: number,
): "info" | "low" | "medium" | "high" | "critical" {
  const [first, second] = ranked.filter((o) => !o.excluded);
  if (!first) return "high";
  const margin = first.finalScore - (second?.finalScore ?? 0);
  if (confidence < 0.5 || margin < 0.03) return "high";
  if (first.penalties.length > 0 || confidence < 0.65 || margin < 0.08) return "medium";
  if (confidence >= 0.8 && margin >= 0.15) return "low";
  return "low";
}