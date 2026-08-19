/**
 * Sprint 3 — Context Intelligence Layer (browser-safe contracts).
 *
 * A Business Context Object answers "what is actually going on around this
 * event?" by combining live data, history, business rules and memory.
 */
import { z } from "zod";

export type ContextTrend = "increasing" | "stable" | "decreasing";

export interface OccupancyContext {
  current: number;
  forecast: number;
  historical_average: number;
  trend: ContextTrend;
  confidence: number;
  rooms_total: number;
  window_days: number;
}

export interface GuestContext {
  new_reservations: number;
  returning_guests: number;
  returning_share: number;
  high_value_guests: number;
  top_preferences: string[];
  vip_arrivals: number;
  confidence: number;
}

export interface RevenueContext {
  adr: number;
  adr_baseline: number;
  adr_position: "below_market" | "at_market" | "above_market";
  booking_pace: "accelerating" | "steady" | "slowing";
  revenue_window: number;
  risk: "underpricing" | "overpricing" | "balanced";
  currency: string;
  confidence: number;
}

export interface SeasonalContext {
  month: string;
  season: "high" | "shoulder" | "low";
  same_month_last_year: number;
  current_month_to_date: number;
  yoy_delta_pct: number | null;
  pattern: string;
  confidence: number;
}

export interface MemoryContext {
  observed: Array<{ key: string; value: string; confidence: number }>;
  learned: Array<{ key: string; value: string; confidence: number }>;
  strategic: Array<{ key: string; value: string; confidence: number }>;
}

export interface BusinessContext {
  generated_at: string;
  occupancy: OccupancyContext;
  guest: GuestContext;
  revenue: RevenueContext;
  seasonal: SeasonalContext;
  memory: MemoryContext;
  /** Plain-language sentences a manager can read directly. */
  narrative: string[];
}

export const businessContextSchema = z.object({
  windowDays: z.number().int().min(1).max(90).default(14),
});
export type BusinessContextInput = z.infer<typeof businessContextSchema>;

export const MEMORY_TIERS = ["observed", "learned", "strategic"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const MEMORY_TIER_LABEL: Record<MemoryTier, string> = {
  observed: "Observed — facts recorded from what happened",
  learned: "Learned — patterns the core inferred over time",
  strategic: "Strategic — management preferences that constrain advice",
};

/** Cross-module synthesis output — several modules read as one story. */
export interface CrossModuleFinding {
  key: string;
  module: string;
  title: string;
  summary: string;
  recommendation: { title: string; suggestedAction: string; actionType: string; impact: string };
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;
  reasoningSources: string[];
  evidence: Record<string, unknown>;
}
