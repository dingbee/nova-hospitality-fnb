/**
 * Sprint 4 — Predictive Intelligence Layer (browser-safe contracts).
 *
 *   Historical data + Current context + Business patterns + Seasonality + Memory
 *                                   ↓
 *                            Prediction engine
 */
import { z } from "zod";

export const FORECAST_KINDS = ["demand", "revenue", "operational_risk", "guest_experience"] as const;
export type ForecastKind = (typeof FORECAST_KINDS)[number];

export const FORECAST_KIND_LABEL: Record<ForecastKind, string> = {
  demand: "Demand forecast",
  revenue: "Revenue forecast",
  operational_risk: "Operational risk",
  guest_experience: "Guest experience",
};

export interface ForecastDriver {
  label: string;
  detail: string;
  /** Contribution to the prediction, -1..1 (negative pulls the outcome down). */
  weight: number;
}

export interface Forecast {
  key: string;
  kind: ForecastKind;
  module: string;
  label: string;
  horizonDays: number;
  targetDate: string;
  /** Primary numeric outcome (percent, currency or count depending on unit). */
  predictedValue: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  unit: string;
  baselineValue: number | null;
  direction: "up" | "flat" | "down";
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;
  /** One manager-readable sentence stating what is likely to happen and why. */
  statement: string;
  drivers: ForecastDriver[];
  reasoningSources: string[];
  recommendation: {
    title: string;
    suggestedAction: string;
    actionType: string;
    impact: string;
  } | null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- serialisable evidence bag */
  evidence: Record<string, any>;
}

export interface ForecastAccuracy {
  scored: number;
  averageAccuracy: number | null;
  byKind: Array<{ predictionKey: string; scored: number; averageAccuracy: number }>;
}

export interface ForecastBoard {
  generated_at: string;
  horizon_days: number;
  headline: string;
  forecasts: Forecast[];
  accuracy: ForecastAccuracy;
}

export const forecastBoardSchema = z.object({
  horizonDays: z.number().int().min(7).max(90).default(14),
});
export type ForecastBoardInput = z.infer<typeof forecastBoardSchema>;

export const runForecastSchema = z.object({
  horizonDays: z.number().int().min(7).max(90).default(14),
  /** Persist predictions and create prediction-backed recommendations. */
  persist: z.boolean().default(true),
});
export type RunForecastInput = z.infer<typeof runForecastSchema>;

export interface RunForecastResult {
  forecastsProduced: number;
  predictionsRecorded: number;
  recommendationsCreated: number;
  headline: string;
}