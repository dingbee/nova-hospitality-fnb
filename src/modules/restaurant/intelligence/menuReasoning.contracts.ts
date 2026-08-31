/**
 * INT-01 — Menu Intelligence reasoning contracts (browser-safe).
 *
 * The structured result a model returns is never trusted as-is: it is
 * parsed then validated against this schema before anything downstream
 * (the UI, an evaluation event) ever sees it. A response that fails
 * validation is a controlled degraded result, never persisted as trusted
 * intelligence — see menuReasoning.server.ts.
 */
import { z } from "zod";

/** Bump when the system prompt's instructions materially change — recorded on every evaluation so a later "did quality improve after v2" comparison is possible. */
export const MENU_INTELLIGENCE_PROMPT_VERSION = "menu-intelligence-v1";

/**
 * Bounded, closed vocabulary — the model may only cite a reason already on
 * this list. Prevents an unbounded, free-text "why" field from smuggling in
 * invented causes untethered from the supplied facts.
 */
export const MENU_REASON_CODES = [
  "demand_increase",
  "demand_decline",
  "margin_strong",
  "margin_weak",
  "cost_variance",
  "stockout_or_availability_risk",
  "pricing_opportunity",
  "recipe_cost_stale",
  "top_profit_contributor",
  "insufficient_evidence",
] as const;
export type MenuReasonCode = (typeof MENU_REASON_CODES)[number];

export const MENU_REASONING_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type MenuReasoningPriority = (typeof MENU_REASONING_PRIORITIES)[number];

/**
 * The validated shape of a model's answer. `.strict()` rejects any
 * unrecognised field outright — an LLM padding its JSON with an extra key
 * (e.g. a fabricated "predicted_revenue") fails validation rather than
 * silently passing through.
 */
export const menuReasoningResultSchema = z
  .object({
    insight: z.string().min(1).max(2000),
    recommendation: z.string().min(1).max(1000),
    confidence: z.number().min(0).max(1),
    priority: z.enum(MENU_REASONING_PRIORITIES),
    reasonCodes: z.array(z.enum(MENU_REASON_CODES)).max(6),
    /** Must be a subset of the factIds actually present in the context supplied — checked post-parse in menuReasoning.server.ts (a schema alone can't know what was in that particular call's context). */
    supportingFactIds: z.array(z.string().max(200)).max(20),
  })
  .strict();
export type MenuReasoningResult = z.infer<typeof menuReasoningResultSchema>;

export const REASONING_PROVIDERS = ["openai", "gemini"] as const;

export const runMenuIntelligenceReasoningSchema = z.object({
  tenantId: z.string().uuid(),
  /** Free text, but the UI only ever offers the three INT-01 starter questions — this isn't a general chat surface. */
  question: z.string().min(1).max(500),
  windowDays: z.number().int().min(7).max(120).default(30),
  provider: z.enum(REASONING_PROVIDERS).default("openai"),
});
export type RunMenuIntelligenceReasoningInput = z.infer<typeof runMenuIntelligenceReasoningSchema>;

/** The three questions INT-01's vertical slice must answer — offered verbatim in the UI, not invented per-call by a free-text box. */
export const MENU_INTELLIGENCE_STARTER_QUESTIONS = [
  "What is selling?",
  "What is profitable?",
  "What should management do about it?",
] as const;
