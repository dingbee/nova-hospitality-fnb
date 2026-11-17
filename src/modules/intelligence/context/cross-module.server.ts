/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 3 — Cross-Module Intelligence.
 *
 * Single-module reasoning says "5 reservations received".
 * Cross-module reasoning reads Booking + Guest + Revenue + Seasonal together
 * and says "5 reservations are from high-value returning guests — prepare VIP
 * arrivals". Strategic memory constrains what may be recommended.
 */
import type { BusinessContext, CrossModuleFinding } from "./context.types";

const pct = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n)}%`;

/** Pure synthesis — deterministic, explainable, no AI dependency. */
export function synthesiseCrossModule(ctx: BusinessContext): CrossModuleFinding[] {
  const out: CrossModuleFinding[] = [];
  const avoidsDiscounting = ctx.memory.strategic.some((m) =>
    /discount|rate integrity|no promo/i.test(`${m.key} ${m.value}`),
  );

  // Booking × Guest × Operations — VIP pre-arrival preparation.
  if (ctx.guest.new_reservations > 0 && (ctx.guest.returning_guests > 0 || ctx.guest.vip_arrivals > 0)) {
    const strength = Math.max(ctx.guest.returning_guests, ctx.guest.vip_arrivals);
    out.push({
      key: "cross.vip_prearrival",
      module: "guest",
      title: "High-value returning guests in the arrival pipeline",
      summary:
        `${ctx.guest.new_reservations} new reservations include ${ctx.guest.returning_guests} returning guests ` +
        `(${ctx.guest.returning_share}% of intake), ${ctx.guest.high_value_guests} high-value and ${ctx.guest.vip_arrivals} VIP. ` +
        (ctx.guest.top_preferences.length
          ? `Known preferences: ${ctx.guest.top_preferences.join(", ")}. `
          : "") +
        `Occupancy is forecast at ${ctx.occupancy.forecast}% over the next ${ctx.occupancy.window_days} days, so room allocation choices matter.`,
      recommendation: {
        title: "Prepare VIP pre-arrival for returning guests",
        suggestedAction:
          "Assign preferred rooms, brief housekeeping and front desk on stored preferences, and send a personalised pre-arrival note.",
        actionType: "guest.vip_prearrival",
        impact: "Protects repeat-guest loyalty and raises in-stay spend",
      },
      severity: strength >= 3 ? "high" : "medium",
      confidence: Math.min(0.95, (ctx.guest.confidence + ctx.occupancy.confidence) / 2 + 0.05),
      reasoningSources: ["booking_intake", "guest_history", "guest_preferences", "occupancy_forecast"],
      evidence: { guest: ctx.guest, occupancy_forecast: ctx.occupancy.forecast },
    });
  }

  // Revenue × Booking pace × Seasonal — pricing position.
  if (ctx.revenue.risk !== "balanced") {
    const underpricing = ctx.revenue.risk === "underpricing";
    out.push({
      key: `cross.pricing_${ctx.revenue.risk}`,
      module: "revenue",
      title: underpricing ? "Demand is outpacing rate" : "Rate is ahead of demand",
      summary:
        `ADR is ${ctx.revenue.currency} ${ctx.revenue.adr} against a ${ctx.revenue.currency} ${ctx.revenue.adr_baseline} baseline ` +
        `(${ctx.revenue.adr_position.replace("_", " ")}), booking pace is ${ctx.revenue.booking_pace}, and occupancy is trending ` +
        `${ctx.occupancy.trend} (${ctx.occupancy.forecast}% forecast vs ${ctx.occupancy.historical_average}% average). ` +
        `${ctx.seasonal.month} is ${ctx.seasonal.season} season — ${ctx.seasonal.pattern}`,
      recommendation: underpricing
        ? {
            title: "Lift rate on the strongest dates",
            suggestedAction:
              "Raise rates on the highest-demand dates in the next 30 days and close the lowest rate plans before inventory thins.",
            actionType: "revenue.review_pricing",
            impact: "Recovers RevPAR without reducing volume",
          }
        : {
            title: avoidsDiscounting ? "Widen reach instead of cutting rate" : "Re-balance rate for softening demand",
            suggestedAction: avoidsDiscounting
              ? "Management preference is to protect rate integrity — increase marketing reach and add value inclusions rather than discounting."
              : "Review rate parity and consider a targeted, time-boxed offer on the softest dates.",
            actionType: "revenue.review_pricing",
            impact: "Protects occupancy while defending rate positioning",
          },
      severity: "medium",
      confidence: Math.min(0.9, (ctx.revenue.confidence + ctx.occupancy.confidence) / 2),
      reasoningSources: [
        "adr_position",
        "booking_pace",
        "occupancy_forecast",
        "seasonal_pattern",
        ...(avoidsDiscounting ? ["strategic_memory"] : []),
      ],
      evidence: { revenue: ctx.revenue, occupancy: ctx.occupancy, seasonal: ctx.seasonal },
    });
  }

  // Seasonal × Booking — year-on-year positioning with learned patterns.
  if (ctx.seasonal.yoy_delta_pct !== null && Math.abs(ctx.seasonal.yoy_delta_pct) >= 15) {
    const up = ctx.seasonal.yoy_delta_pct > 0;
    out.push({
      key: "cross.seasonal_yoy",
      module: "marketing",
      title: up ? "Season is running ahead of last year" : "Season is running behind last year",
      summary:
        `${ctx.seasonal.month} month-to-date reservations are ${pct(ctx.seasonal.yoy_delta_pct)} versus the same point last year ` +
        `(${ctx.seasonal.current_month_to_date} vs ${ctx.seasonal.same_month_last_year}). ${ctx.seasonal.pattern}` +
        (ctx.memory.learned.length
          ? ` Learned pattern: ${ctx.memory.learned[0]!.value}`
          : ""),
      recommendation: up
        ? {
            title: "Protect the lead — hold inventory for higher-yield demand",
            suggestedAction: "Review length-of-stay rules and keep premium inventory open for late high-rate demand.",
            actionType: "revenue.review_inventory",
            impact: "Converts a strong season into higher yield",
          }
        : {
            title: "Bring forward demand generation",
            suggestedAction:
              "Advance the campaign calendar for this period and re-target previous guests who stayed in this month before.",
            actionType: "marketing.launch_campaign",
            impact: "Closes the year-on-year gap before lead time runs out",
          },
      severity: Math.abs(ctx.seasonal.yoy_delta_pct) >= 30 ? "high" : "medium",
      confidence: ctx.seasonal.confidence,
      reasoningSources: ["seasonal_pattern", "yoy_comparison", ...(ctx.memory.learned.length ? ["learned_memory"] : [])],
      evidence: { seasonal: ctx.seasonal },
    });
  }

  return out;
}

type Sb = any;

/** Persist findings as context-rich insights + recommendations (idempotent per day). */
export async function persistCrossModuleFindings(
  supabase: Sb,
  findings: CrossModuleFinding[],
  ctx: BusinessContext,
  allowedModules: string[],
): Promise<{ insightsCreated: number; recommendationsCreated: number }> {
  const day = new Date().toISOString().slice(0, 10);
  let insightsCreated = 0;
  let recommendationsCreated = 0;

  for (const f of findings) {
    if (!allowedModules.includes(f.module)) continue;
    const key = `${f.key}.${day}`;

    const { data: existingInsight } = await supabase
      .from("intelligence_insights")
      .select("id")
      .eq("module", f.module)
      .eq("insight_key", key)
      .maybeSingle();

    let insightId: string | null = existingInsight?.id ?? null;
    if (!insightId) {
      const { data: ins } = await supabase
        .from("intelligence_insights")
        .insert({
          module: f.module,
          insight_key: key,
          title: f.title,
          summary: f.summary,
          severity: f.severity,
          importance: f.severity === "high" ? 4 : 3,
          confidence: Math.round(f.confidence * 100) / 100,
          evidence: f.evidence,
          reasoning_sources: f.reasoningSources,
          context: ctx as unknown as Record<string, unknown>,
          generated_by: "context-engine",
        })
        .select("id")
        .single();
      if (ins) {
        insightId = ins.id as string;
        insightsCreated += 1;
      }
    }

    const { data: existingRec } = await supabase
      .from("intelligence_recommendations")
      .select("id")
      .eq("module", f.module)
      .eq("recommendation_key", key)
      .in("status", ["new", "reviewing"])
      .maybeSingle();
    if (!existingRec) {
      const { error } = await supabase.from("intelligence_recommendations").insert({
        module: f.module,
        insight_id: insightId,
        recommendation_key: key,
        title: f.recommendation.title,
        rationale: `${f.summary}\n\nContext: ${ctx.narrative.join(" ")}`,
        suggested_action: f.recommendation.suggestedAction,
        action_type: f.recommendation.actionType,
        action_payload: f.evidence,
        expected_impact: f.recommendation.impact,
        priority: f.severity === "high" ? 4 : 3,
        confidence: Math.round(f.confidence * 100) / 100,
        reasoning_sources: f.reasoningSources,
        context: ctx as unknown as Record<string, unknown>,
      });
      if (!error) recommendationsCreated += 1;
    }
  }

  return { insightsCreated, recommendationsCreated };
}
