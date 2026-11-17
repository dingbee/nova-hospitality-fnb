/**
 * P04 §6 — Customer Health Engine: a deterministic, weighted, rule-based
 * classifier. Pure and browser-safe (no I/O) so the scoring model itself is
 * directly unit-testable without a database, exactly the same "extract the
 * pure logic" discipline this codebase already applies to billing-period.ts
 * and lib/notifications/attention.ts.
 *
 * `computeHealth` takes only the facts intelligence.server.ts has already
 * read from the authoritative P01/P02/P03 tables — it never re-derives a
 * balance, an ageing bucket, or a renewal date itself. The score is a
 * plain sum of documented, named weights; the four bands are simple
 * threshold cuts. Nothing here is a hidden/cosmetic multiplier.
 */

export const HEALTH_BANDS = ["HEALTHY", "WATCH", "AT_RISK", "CRITICAL"] as const;
export type HealthBand = (typeof HEALTH_BANDS)[number];

export interface HealthReason {
  code: string;
  points: number;
  detail: string;
}

export interface HealthResult {
  score: number;
  band: HealthBand;
  reasons: HealthReason[];
}

export type AgeingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export interface HealthFacts {
  subscriptionStatus: string | null;
  /** Worst (most overdue) ageing bucket across the tenant's outstanding invoices, or "current" if none. */
  worstAgeingBucket: AgeingBucket;
  outstandingBalance: number;
  /** Days until renewal_date; negative means the date has already passed without a recorded renewal. Null when no renewal date is on record. */
  daysUntilRenewal: number | null;
  /** Worst usage-quota state observed this period across the tenant's usage counters, if any. */
  worstQuotaState:
    "NORMAL" | "WARNING" | "NEAR_LIMIT" | "LIMIT_REACHED" | "BLOCKED" | "OVERRIDE" | null;
  /** True when the tenant's most recent agreement renewal reduced monthly-equivalent revenue vs. the one it superseded. */
  recentContraction: boolean;
}

const AGEING_POINTS: Record<AgeingBucket, number> = {
  current: 0,
  "1-30": 10,
  "31-60": 20,
  "61-90": 30,
  "90+": 40,
};

const QUOTA_POINTS: Record<NonNullable<HealthFacts["worstQuotaState"]>, number> = {
  NORMAL: 0,
  WARNING: 3,
  NEAR_LIMIT: 8,
  LIMIT_REACHED: 12,
  BLOCKED: 15,
  OVERRIDE: 0,
};

/** Terminal subscription states are CRITICAL by definition — no further scoring is meaningful once a subscription is suspended or cancelled. */
const TERMINAL_CRITICAL_STATUSES = new Set(["suspended", "cancelled"]);

export function computeHealth(facts: HealthFacts): HealthResult {
  if (facts.subscriptionStatus && TERMINAL_CRITICAL_STATUSES.has(facts.subscriptionStatus)) {
    return {
      score: 100,
      band: "CRITICAL",
      reasons: [
        {
          code: "subscription_terminal",
          points: 100,
          detail: `Subscription is ${facts.subscriptionStatus}.`,
        },
      ],
    };
  }

  const reasons: HealthReason[] = [];

  const ageingPoints = AGEING_POINTS[facts.worstAgeingBucket];
  if (ageingPoints > 0) {
    reasons.push({
      code: "overdue_ageing",
      points: ageingPoints,
      detail: `Worst outstanding invoice is in the ${facts.worstAgeingBucket}-day ageing bucket.`,
    });
  }

  if (facts.outstandingBalance > 0) {
    reasons.push({
      code: "outstanding_balance",
      points: 10,
      detail: `Outstanding balance of ${facts.outstandingBalance.toLocaleString()} on record.`,
    });
  }

  if (facts.subscriptionStatus === "past_due") {
    reasons.push({
      code: "subscription_past_due",
      points: 25,
      detail: "Subscription is past due.",
    });
  }

  if (facts.daysUntilRenewal != null) {
    if (facts.daysUntilRenewal < 0) {
      reasons.push({
        code: "renewal_overdue",
        points: 20,
        detail: `Renewal date passed ${Math.abs(facts.daysUntilRenewal)} day(s) ago with no recorded renewal.`,
      });
    } else if (facts.daysUntilRenewal <= 7) {
      reasons.push({
        code: "renewal_imminent",
        points: 15,
        detail: `Renewal due in ${facts.daysUntilRenewal} day(s).`,
      });
    }
  }

  if (facts.worstQuotaState) {
    const quotaPoints = QUOTA_POINTS[facts.worstQuotaState];
    if (quotaPoints > 0) {
      reasons.push({
        code: "quota_pressure",
        points: quotaPoints,
        detail: `Worst usage quota state this period: ${facts.worstQuotaState}.`,
      });
    }
  }

  if (facts.recentContraction) {
    reasons.push({
      code: "recent_contraction",
      points: 10,
      detail: "Most recent renewal reduced recurring revenue versus the agreement it superseded.",
    });
  }

  const score = Math.min(
    100,
    reasons.reduce((s, r) => s + r.points, 0),
  );

  const band: HealthBand =
    score >= 60 ? "CRITICAL" : score >= 35 ? "AT_RISK" : score >= 15 ? "WATCH" : "HEALTHY";

  return { score, band, reasons };
}
