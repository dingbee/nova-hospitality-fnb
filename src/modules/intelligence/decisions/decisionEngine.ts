/**
 * Sprint 5 — Decision engine.
 *
 * Takes the existing Business Context (Sprint 3) and Forecasts (Sprint 4) and
 * turns each material prediction into a decision: candidate options, weighted
 * evaluation, constraint handling, ranking, reasoning, evidence and risk.
 *
 * Pure: no Supabase, no AI. Same inputs → identical decisions.
 */
import type { BusinessContext } from "../context/context.types";
import type { Forecast } from "../predictions/forecast.types";
import {
  type Decision,
  type DecisionConstraint,
  type DecisionDomain,
  type DecisionEvidence,
  type DecisionOption,
  type EvaluatedOption,
} from "./decision.types";
import { deriveConstraints, requiresApprovalFor, riskLevelFor, weightsFor } from "./decisionRules";
import { decisionConfidence, evaluateOptions, explainRanking } from "./optionEvaluator";
import { buildPlan } from "./planningEngine";

const pct = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n)}%`;

/* ---------------- option catalogues ----------------
 * Catalogues are per-situation, not per-property, so any future module can add
 * its own catalogue and reuse the whole evaluation framework unchanged.
 */

function risingDemandOptions(ctx: BusinessContext): DecisionOption[] {
  const belowBand = ctx.revenue.adr_position === "below_market";
  return [
    {
      key: "broad_discount",
      title: "Broad discount across the window",
      summary: "Cut published rates across all dates to accelerate pickup.",
      actionType: "revenue.review_pricing",
      tactics: ["Reduce published rate across all rate plans", "Notify channels of the new rate"],
      scores: {
        expected_revenue: 0.25,
        occupancy_impact: 0.8,
        margin_impact: 0.15,
        guest_experience: 0.45,
        strategic_alignment: 0.1,
        operational_feasibility: 0.8,
        risk: 0.3,
        historical_evidence: 0.35,
      },
      tags: ["broad_discount", "aggressive_rate_move", "demand_generation"],
      effort: "low",
    },
    {
      key: "hold_rate",
      title: "Hold rate unchanged",
      summary: "Change nothing and let demand convert at the current price.",
      actionType: "revenue.no_change",
      tactics: ["Monitor booking velocity daily"],
      scores: {
        expected_revenue: 0.5,
        occupancy_impact: 0.5,
        margin_impact: 0.6,
        guest_experience: 0.6,
        strategic_alignment: 0.65,
        operational_feasibility: 1,
        risk: 0.8,
        historical_evidence: 0.5,
      },
      tags: [],
      effort: "low",
    },
    {
      key: "increase_adr",
      title: "Increase ADR on the strongest dates",
      summary: "Lift rate one band on peak dates and close the lowest rate plans.",
      actionType: "revenue.review_pricing",
      tactics: ["Lift rate one band on peak dates", "Close the two lowest rate plans"],
      scores: {
        expected_revenue: belowBand ? 0.9 : 0.75,
        occupancy_impact: 0.45,
        margin_impact: 0.9,
        guest_experience: 0.5,
        strategic_alignment: 0.85,
        operational_feasibility: 0.85,
        risk: 0.55,
        historical_evidence: belowBand ? 0.7 : 0.55,
      },
      tags: [],
      effort: "low",
    },
    {
      key: "value_package",
      title: "Value-added direct package",
      summary: "Keep rate integrity and add an inclusion (dinner, transfer, late checkout).",
      actionType: "marketing.launch_campaign",
      tactics: [
        "Build a value-added direct-booking package",
        "Publish the package on the website and pre-arrival emails",
      ],
      scores: {
        expected_revenue: 0.7,
        occupancy_impact: 0.65,
        margin_impact: 0.6,
        guest_experience: 0.9,
        strategic_alignment: 0.85,
        operational_feasibility: 0.6,
        risk: 0.75,
        historical_evidence: 0.6,
      },
      tags: ["high_ops_load"],
      effort: "medium",
    },
    {
      key: "direct_marketing",
      title: "Targeted direct marketing to past guests",
      summary: "Re-target previous guests who stayed in this season, direct channel only.",
      actionType: "marketing.launch_campaign",
      tactics: ["Segment previous guests from this season", "Send a direct-booking offer"],
      scores: {
        expected_revenue: 0.6,
        occupancy_impact: 0.7,
        margin_impact: 0.7,
        guest_experience: 0.75,
        strategic_alignment: 0.75,
        operational_feasibility: 0.7,
        risk: 0.7,
        historical_evidence: 0.6,
      },
      tags: ["demand_generation"],
      effort: "medium",
    },
    {
      key: "premium_value_combo",
      title: "Protect rate, add value, market direct",
      summary:
        "Moderate ADR protection on peak dates combined with a value inclusion and a direct-guest campaign.",
      actionType: "revenue.review_pricing",
      tactics: [
        "Hold or lift rate one band on peak dates",
        "Attach a value inclusion instead of discounting",
        "Target returning guests through the direct channel",
      ],
      scores: {
        expected_revenue: 0.85,
        occupancy_impact: 0.7,
        margin_impact: 0.8,
        guest_experience: 0.85,
        strategic_alignment: 0.95,
        operational_feasibility: 0.6,
        risk: 0.7,
        historical_evidence: 0.65,
      },
      tags: ["high_ops_load"],
      effort: "medium",
    },
  ];
}

function softDemandOptions(): DecisionOption[] {
  return [
    {
      key: "broad_discount",
      title: "Broad discount to fill the gap",
      summary: "Drop published rate across the soft window.",
      actionType: "revenue.review_pricing",
      tactics: ["Reduce published rate", "Open discounted inventory to all channels"],
      scores: {
        expected_revenue: 0.35,
        occupancy_impact: 0.85,
        margin_impact: 0.2,
        guest_experience: 0.45,
        strategic_alignment: 0.1,
        operational_feasibility: 0.9,
        risk: 0.35,
        historical_evidence: 0.4,
      },
      tags: ["broad_discount", "aggressive_rate_move"],
      effort: "low",
    },
    {
      key: "value_package",
      title: "Value-added package instead of a discount",
      summary: "Hold rate and add an experience inclusion to lift conversion.",
      actionType: "marketing.launch_campaign",
      tactics: ["Bundle an experience inclusion", "Feature the package on the website"],
      scores: {
        expected_revenue: 0.7,
        occupancy_impact: 0.65,
        margin_impact: 0.6,
        guest_experience: 0.9,
        strategic_alignment: 0.9,
        operational_feasibility: 0.65,
        risk: 0.75,
        historical_evidence: 0.6,
      },
      tags: ["high_ops_load"],
      effort: "medium",
    },
    {
      key: "repeat_guest_offer",
      title: "Targeted repeat-guest offer",
      summary: "A closed, non-public offer to previous guests only.",
      actionType: "marketing.launch_campaign",
      tactics: ["Segment repeat guests", "Send a private offer with a short window"],
      scores: {
        expected_revenue: 0.65,
        occupancy_impact: 0.7,
        margin_impact: 0.65,
        guest_experience: 0.8,
        strategic_alignment: 0.85,
        operational_feasibility: 0.75,
        risk: 0.75,
        historical_evidence: 0.6,
      },
      tags: [],
      effort: "low",
    },
    {
      key: "increase_marketing",
      title: "Increase direct marketing reach",
      summary: "Raise paid and organic reach on the soft dates without touching rate.",
      actionType: "marketing.launch_campaign",
      tactics: ["Increase campaign budget on soft dates", "Refresh creative for the season"],
      scores: {
        expected_revenue: 0.55,
        occupancy_impact: 0.6,
        margin_impact: 0.5,
        guest_experience: 0.7,
        strategic_alignment: 0.8,
        operational_feasibility: 0.7,
        risk: 0.6,
        historical_evidence: 0.5,
      },
      tags: ["demand_generation"],
      effort: "medium",
    },
    {
      key: "hold_rate",
      title: "Hold and monitor",
      summary: "Take no action for 72 hours and re-evaluate.",
      actionType: "revenue.no_change",
      tactics: ["Monitor pickup for 72 hours"],
      scores: {
        expected_revenue: 0.45,
        occupancy_impact: 0.35,
        margin_impact: 0.7,
        guest_experience: 0.6,
        strategic_alignment: 0.6,
        operational_feasibility: 1,
        risk: 0.65,
        historical_evidence: 0.5,
      },
      tags: [],
      effort: "low",
    },
  ];
}

function operationalRiskOptions(): DecisionOption[] {
  return [
    {
      key: "add_shift_cover",
      title: "Add housekeeping cover on the peak turnover day",
      summary: "Roster additional cover so turnovers stay inside the service window.",
      actionType: "operations.adjust_roster",
      tactics: ["Roster additional housekeeping cover", "Brief the supervisor on turnover order"],
      scores: {
        operational_feasibility: 0.75,
        guest_experience: 0.85,
        risk: 0.8,
        margin_impact: 0.45,
        historical_evidence: 0.6,
      },
      tags: ["high_ops_load"],
      effort: "medium",
    },
    {
      key: "stagger_checkin",
      title: "Stagger arrival times",
      summary: "Spread arrivals across the afternoon to flatten the turnover peak.",
      actionType: "operations.stagger_arrivals",
      tactics: ["Contact arriving guests with staggered arrival windows"],
      scores: {
        operational_feasibility: 0.85,
        guest_experience: 0.6,
        risk: 0.7,
        margin_impact: 0.8,
        historical_evidence: 0.55,
      },
      tags: [],
      effort: "low",
    },
    {
      key: "reduce_service",
      title: "Reduce mid-stay servicing",
      summary: "Skip mid-stay servicing to free capacity for departures.",
      actionType: "operations.reduce_service",
      tactics: ["Suspend mid-stay servicing for one day"],
      scores: {
        operational_feasibility: 0.9,
        guest_experience: 0.25,
        risk: 0.45,
        margin_impact: 0.85,
        historical_evidence: 0.4,
      },
      tags: ["service_reduction"],
      effort: "low",
    },
    {
      key: "prioritise_early_rooms",
      title: "Prioritise rooms with early arrivals",
      summary: "Sequence cleaning by arrival time instead of floor order.",
      actionType: "operations.sequence_cleaning",
      tactics: ["Re-sequence the cleaning board by arrival time", "Flag early arrivals to reception"],
      scores: {
        operational_feasibility: 0.95,
        guest_experience: 0.75,
        risk: 0.8,
        margin_impact: 0.9,
        historical_evidence: 0.6,
      },
      tags: [],
      effort: "low",
    },
  ];
}

function guestExperienceOptions(): DecisionOption[] {
  return [
    {
      key: "vip_prearrival",
      title: "Run a VIP pre-arrival preparation pass",
      summary: "Prepare rooms, preferences and welcome touches ahead of VIP arrivals.",
      actionType: "guest.prepare_vip_arrival",
      tactics: [
        "Review VIP guest preferences and past stays",
        "Brief housekeeping and reception on the arrival",
        "Prepare the personalised welcome",
      ],
      scores: {
        guest_experience: 0.95,
        strategic_alignment: 0.85,
        operational_feasibility: 0.7,
        expected_revenue: 0.6,
        risk: 0.85,
      },
      tags: ["high_ops_load"],
      effort: "medium",
    },
    {
      key: "standard_service",
      title: "Standard arrival handling",
      summary: "Handle the arrivals through the normal front-desk process.",
      actionType: "guest.no_change",
      tactics: ["Follow the standard arrival checklist"],
      scores: {
        guest_experience: 0.5,
        strategic_alignment: 0.4,
        operational_feasibility: 1,
        expected_revenue: 0.5,
        risk: 0.6,
      },
      tags: [],
      effort: "low",
    },
    {
      key: "personalised_outreach",
      title: "Pre-arrival personalised outreach",
      summary: "Contact the guest before arrival to confirm preferences and offer experiences.",
      actionType: "guest.pre_arrival_outreach",
      tactics: ["Send a personalised pre-arrival message", "Offer relevant experiences"],
      scores: {
        guest_experience: 0.85,
        strategic_alignment: 0.8,
        operational_feasibility: 0.85,
        expected_revenue: 0.7,
        risk: 0.8,
      },
      tags: [],
      effort: "low",
    },
  ];
}

interface Situation {
  key: string;
  domain: DecisionDomain;
  module: string;
  title: string;
  trigger: string;
  options: DecisionOption[];
  evidence: DecisionEvidence[];
  assumptions: string[];
  uncertainties: string[];
  risks: string[];
  expectedOutcomes: (top: EvaluatedOption) => string[];
}

function situationsFor(ctx: BusinessContext, forecasts: Forecast[]): Array<{ f: Forecast; s: Situation }> {
  const out: Array<{ f: Forecast; s: Situation }> = [];

  for (const f of forecasts) {
    const evidence: DecisionEvidence[] = [
      { label: "Forecast", value: f.statement },
      { label: "Occupancy today", value: `${ctx.occupancy.current}%` },
      { label: "Occupancy forecast", value: `${ctx.occupancy.forecast}% (${ctx.occupancy.trend})` },
      { label: "ADR", value: `${ctx.revenue.currency} ${ctx.revenue.adr} (${ctx.revenue.adr_position.replace("_", " ")})` },
      { label: "Booking pace", value: ctx.revenue.booking_pace },
      { label: "Season", value: `${ctx.seasonal.month} — ${ctx.seasonal.season}` },
      ...(ctx.seasonal.yoy_delta_pct === null
        ? []
        : [{ label: "Year on year", value: pct(ctx.seasonal.yoy_delta_pct) }]),
      ...f.drivers.map((d) => ({ label: d.label, value: d.detail })),
    ];

    if (f.kind === "demand") {
      const rising = f.direction !== "down" && (f.predictedValue ?? 0) >= ctx.occupancy.historical_average;
      out.push({
        f,
        s: {
          key: rising ? "decision.demand.rising" : "decision.demand.soft",
          domain: rising ? "revenue" : "demand",
          module: rising ? "revenue" : "marketing",
          title: rising
            ? "How should we respond to strengthening demand?"
            : "How should we respond to the softer demand window?",
          trigger: f.label,
          options: rising ? risingDemandOptions(ctx) : softDemandOptions(),
          evidence,
          assumptions: [
            `Late pickup follows the ${ctx.revenue.booking_pace} pace observed over the last ${ctx.occupancy.window_days} days`,
            `${ctx.seasonal.season}-season behaviour repeats — ${ctx.seasonal.pattern}`,
            "No cancellation spike inside the window",
          ],
          uncertainties: [
            `Occupancy could land anywhere between ${f.lowerBound ?? "—"}% and ${f.upperBound ?? "—"}%`,
            "Competitor pricing is not observed by the core",
          ],
          risks: rising
            ? [
                "Demand may normalise faster than forecast, leaving peak-date inventory unsold at the higher rate",
                "Rate movement is visible to returning guests and can affect perceived fairness",
              ]
            : [
                "Demand generation may not convert before lead time runs out",
                "Promotional activity can pull forward bookings that would have arrived anyway",
              ],
          expectedOutcomes: (top) => [
            `Occupancy tracks toward ${f.predictedValue ?? "—"}${f.unit} within ${f.horizonDays} days`,
            `${top.option.title} is expected to be the strongest lever on ${rising ? "ADR" : "pickup"} without breaching constraints`,
            "Re-evaluate after 72 hours of booking velocity",
          ],
        },
      });
    }

    if (f.kind === "operational_risk" && (f.severity === "medium" || f.severity === "high" || f.severity === "critical")) {
      out.push({
        f,
        s: {
          key: "decision.operations.turnover_load",
          domain: "operations",
          module: "operations",
          title: "How should we cover the peak turnover load?",
          trigger: f.label,
          options: operationalRiskOptions(),
          evidence,
          assumptions: ["Current roster capacity applies", "No unplanned maintenance blocks"],
          uncertainties: ["Late arrivals and early check-ins can shift the peak"],
          risks: [
            "Rooms may not be ready at the promised check-in time",
            "Overtime cost rises if cover is added late",
          ],
          expectedOutcomes: (top) => [
            "Turnovers complete inside the service window",
            `${top.option.title} keeps guest-facing readiness intact`,
          ],
        },
      });
    }

    if (f.kind === "guest_experience") {
      out.push({
        f,
        s: {
          key: "decision.guest.service_load",
          domain: "guest_experience",
          module: "guest",
          title: "How should we prepare for the incoming service load?",
          trigger: f.label,
          options: guestExperienceOptions(),
          evidence,
          assumptions: ["Guest preference records are current"],
          uncertainties: ["Preferences captured at booking may be incomplete"],
          risks: ["A missed VIP preference is visible to the guest and hard to recover"],
          expectedOutcomes: (top) => [
            "Arriving high-value guests are recognised on arrival",
            `${top.option.title} raises the chance of a positive post-stay review`,
          ],
        },
      });
    }
  }

  return out;
}

/** Build one decision from a situation plus its prediction. */
export function buildDecision(
  ctx: BusinessContext,
  forecast: Forecast,
  situation: Situation,
  extraConstraints: DecisionConstraint[] = [],
): Decision {
  const constraints = deriveConstraints(ctx, extraConstraints);
  const weights = weightsFor(situation.domain);
  const ranked = evaluateOptions(situation.options, weights, constraints);
  const top = ranked.find((o) => !o.excluded) ?? null;
  const confidence = decisionConfidence(ranked, forecast.confidence);
  const riskLevel = riskLevelFor(ranked, confidence);

  const reasoning = {
    whatIsHappening: `${situation.trigger}: ${forecast.statement}`,
    whyItMatters: `${ctx.narrative[0] ?? "The business context has shifted."} This affects ${situation.domain.replace("_", " ")} decisions over the next ${forecast.horizonDays} days.`,
    whatIsLikely: `${forecast.label} — ${forecast.predictedValue ?? "—"}${forecast.unit} (range ${forecast.lowerBound ?? "—"}–${forecast.upperBound ?? "—"}${forecast.unit}) at ${Math.round(forecast.confidence * 100)}% prediction confidence.`,
    optionsConsidered: ranked.map(
      (o) =>
        `${o.rank}. ${o.option.title} — score ${Math.round(o.finalScore * 100)}${o.excluded ? " (excluded)" : ""}`,
    ),
    tradeOffs: ranked
      .slice(0, 4)
      .map((o) => `${o.option.title}: ${[...o.strengths, ...o.tradeOffs].join("; ") || "balanced across all criteria"}`),
    selectedOption: top?.option.title ?? "No option satisfied the active constraints",
    whySelected: explainRanking(ranked),
    whatCouldGoWrong: situation.risks,
    whatHappensNext: top ? top.option.tactics : ["Escalate to management — every option breached a constraint."],
  };

  const plan = buildPlan({
    domain: situation.domain,
    module: situation.module,
    top,
    horizonDays: forecast.horizonDays,
  });

  return {
    key: `${situation.key}.${forecast.targetDate}`,
    module: situation.module,
    domain: situation.domain,
    title: situation.title,
    trigger: situation.trigger,
    status: "proposed",
    riskLevel,
    confidence,
    requiresApproval: requiresApprovalFor(situation.domain, top ?? undefined),
    criteriaWeights: weights,
    constraints,
    options: ranked,
    recommendedOptionKey: top?.option.key ?? null,
    reasoning,
    expectedOutcomes: top ? situation.expectedOutcomes(top) : ["No expected outcome — no acceptable option."],
    evidence: situation.evidence,
    assumptions: situation.assumptions,
    uncertainties: situation.uncertainties,
    risks: situation.risks,
    reasoningSources: ["decision_engine", "prediction_engine", ...forecast.reasoningSources],
    predictionKeys: [forecast.key],
    plan,
  };
}

/** Evaluate every material forecast and return ranked decisions. */
export function buildDecisions(ctx: BusinessContext, forecasts: Forecast[]): Decision[] {
  return situationsFor(ctx, forecasts)
    .map(({ f, s }) => buildDecision(ctx, f, s))
    .sort((a, b) => b.confidence - a.confidence);
}

export function decisionHeadline(decisions: Decision[]): string {
  if (decisions.length === 0) return "No decisions require attention right now.";
  const top = decisions[0];
  const rec = top.options.find((o) => o.option.key === top.recommendedOptionKey);
  return `${top.title} → ${rec?.option.title ?? "no acceptable option"} (confidence ${Math.round(top.confidence * 100)}%, risk ${top.riskLevel}).`;
}