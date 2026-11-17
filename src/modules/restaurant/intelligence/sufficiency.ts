/**
 * P05 §15 — Data Sufficiency.
 *
 * Pure, deterministic banding of "do we actually have enough history to say
 * this with a straight face" — the same presentation-integrity discipline
 * confidence.ts already applies to the AI reasoning layer's self-reported
 * confidence, extended to the P05 deterministic engines (Demand, Forecasting,
 * Revenue, Advanced Analytics, Executive) so none of them ever produce an
 * authoritative-looking number from a handful of transactions.
 *
 * Bands are driven by two independent signals — how many observations exist,
 * and how many distinct days they span — because a single busy day can
 * produce dozens of rows without saying anything about a weekly or seasonal
 * pattern. Both thresholds must be met to advance a band.
 */

export const DATA_SUFFICIENCY_STATES = [
  "NO_DATA",
  "INSUFFICIENT_DATA",
  "LIMITED_CONFIDENCE",
  "SUFFICIENT_DATA",
  "HIGH_CONFIDENCE",
] as const;
export type DataSufficiency = (typeof DATA_SUFFICIENCY_STATES)[number];

export const DATA_SUFFICIENCY_LABEL: Record<DataSufficiency, string> = {
  NO_DATA: "No data",
  INSUFFICIENT_DATA: "Insufficient data",
  LIMITED_CONFIDENCE: "Limited confidence",
  SUFFICIENT_DATA: "Sufficient data",
  HIGH_CONFIDENCE: "High confidence",
};

export interface SufficiencyAssessment {
  state: DataSufficiency;
  label: string;
  sampleSize: number;
  distinctDays: number;
  /** What is missing, in plain language, when the state is below SUFFICIENT_DATA. Empty once sufficient. */
  reasons: string[];
}

/**
 * Thresholds are intentionally conservative and named, not tuned per domain —
 * "enough to say something" is the same bar whether the samples are orders,
 * stock movements, or order lines. A caller with a genuinely different unit
 * of observation may override them, but the defaults are the one place this
 * judgement call is made.
 */
export interface SufficiencyThresholds {
  minSampleLimited: number;
  minDaysLimited: number;
  minSampleSufficient: number;
  minDaysSufficient: number;
  minSampleHigh: number;
  minDaysHigh: number;
}

export const DEFAULT_SUFFICIENCY_THRESHOLDS: SufficiencyThresholds = {
  minSampleLimited: 5,
  minDaysLimited: 3,
  minSampleSufficient: 20,
  minDaysSufficient: 14,
  minSampleHigh: 60,
  minDaysHigh: 30,
};

export function assessDataSufficiency(
  sampleSize: number,
  distinctDays: number,
  thresholds: SufficiencyThresholds = DEFAULT_SUFFICIENCY_THRESHOLDS,
): SufficiencyAssessment {
  const reasons: string[] = [];

  if (sampleSize <= 0) {
    return {
      state: "NO_DATA",
      label: DATA_SUFFICIENCY_LABEL.NO_DATA,
      sampleSize,
      distinctDays,
      reasons: ["No qualifying records were found in this window."],
    };
  }

  let state: DataSufficiency;
  if (sampleSize < thresholds.minSampleLimited || distinctDays < thresholds.minDaysLimited) {
    state = "INSUFFICIENT_DATA";
  } else if (
    sampleSize < thresholds.minSampleSufficient ||
    distinctDays < thresholds.minDaysSufficient
  ) {
    state = "LIMITED_CONFIDENCE";
  } else if (sampleSize < thresholds.minSampleHigh || distinctDays < thresholds.minDaysHigh) {
    state = "SUFFICIENT_DATA";
  } else {
    state = "HIGH_CONFIDENCE";
  }

  if (state !== "HIGH_CONFIDENCE") {
    if (sampleSize < thresholds.minSampleHigh) {
      reasons.push(`Only ${sampleSize} qualifying record(s) observed.`);
    }
    if (distinctDays < thresholds.minDaysHigh) {
      reasons.push(`Only ${distinctDays} distinct day(s) of history observed.`);
    }
  }

  return { state, label: DATA_SUFFICIENCY_LABEL[state], sampleSize, distinctDays, reasons };
}

/** True once a result may be shown with a headline number rather than "insufficient data" messaging. */
export function isUsableSufficiency(state: DataSufficiency): boolean {
  return state !== "NO_DATA" && state !== "INSUFFICIENT_DATA";
}
