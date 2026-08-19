/**
 * Intelligence Core — shared contracts.
 *
 * Browser-safe: types + zod schemas only. Every stage of the loop
 * (Observe → Understand → Reason → Recommend → Act → Learn) is described here
 * so future modules (PMS, Booking, Guest, Revenue, Marketing, Restaurant)
 * integrate against one contract instead of bespoke AI features.
 */
import { z } from "zod";

export const INTEL_MODULES = [
  "pms",
  "booking",
  "guest",
  "revenue",
  "marketing",
  "restaurant",
  "operations",
  "finance",
  "content",
  "platform",
] as const;
export type IntelModule = (typeof INTEL_MODULES)[number];

export const INTEL_STAGES = [
  "observe",
  "understand",
  "reason",
  "recommend",
  "act",
  "learn",
] as const;
export type IntelStage = (typeof INTEL_STAGES)[number];

export const INTEL_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type IntelSeverity = (typeof INTEL_SEVERITIES)[number];

export const INTEL_STATUSES = [
  "new",
  "reviewing",
  "accepted",
  "dismissed",
  "expired",
  "superseded",
] as const;
export type IntelStatus = (typeof INTEL_STATUSES)[number];

export const INTEL_ACTION_STATUSES = [
  "proposed",
  "approved",
  "executing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type IntelActionStatus = (typeof INTEL_ACTION_STATUSES)[number];

export const INTEL_MEMORY_SCOPES = [
  "guest",
  "reservation",
  "room",
  "module",
  "property",
  "global",
] as const;
export type IntelMemoryScope = (typeof INTEL_MEMORY_SCOPES)[number];

const moduleEnum = z.enum(INTEL_MODULES);
const severityEnum = z.enum(INTEL_SEVERITIES);
const statusEnum = z.enum(INTEL_STATUSES);
const confidence = z.number().min(0).max(1);
const uuid = z.string().uuid();

/* ---------------- Observe ---------------- */

export const recordEventSchema = z.object({
  module: moduleEnum,
  eventType: z.string().min(2).max(120),
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
  severity: severityEnum.default("info"),
  source: z.string().max(60).default("system"),
  payload: z.record(z.string(), z.unknown()).default({}),
  correlationId: uuid.optional(),
  /** Idempotency key — the same key never produces a second event. */
  dedupeKey: z.string().max(200).optional(),
  occurredAt: z.string().datetime().optional(),
});
export type RecordEventInput = z.infer<typeof recordEventSchema>;

export const listEventsSchema = z.object({
  module: moduleEnum.optional(),
  eventType: z.string().optional(),
  entityId: uuid.optional(),
  unprocessedOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListEventsInput = z.infer<typeof listEventsSchema>;

/* ---------------- Understand ---------------- */

export const recordSignalSchema = z.object({
  module: moduleEnum,
  signalKey: z.string().min(2).max(120),
  label: z.string().max(200).optional(),
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
  value: z.number().optional(),
  valueText: z.string().max(500).optional(),
  unit: z.string().max(30).optional(),
  confidence: confidence.default(0.5),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  sourceEventIds: z.array(uuid).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RecordSignalInput = z.infer<typeof recordSignalSchema>;

export const listSignalsSchema = z.object({
  module: moduleEnum.optional(),
  signalKey: z.string().optional(),
  entityId: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListSignalsInput = z.infer<typeof listSignalsSchema>;

/* ---------------- Reason ---------------- */

export const recordInsightSchema = z.object({
  module: moduleEnum,
  insightKey: z.string().max(120).optional(),
  title: z.string().min(3).max(200),
  summary: z.string().min(3).max(2000),
  detail: z.string().max(8000).optional(),
  severity: severityEnum.default("info"),
  importance: z.number().int().min(1).max(5).default(3),
  confidence: confidence.default(0.5),
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
  signalIds: z.array(uuid).default([]),
  evidence: z.record(z.string(), z.unknown()).default({}),
  /** Why the core said this — signal keys / heuristics behind the insight. */
  reasoningSources: z.array(z.string().max(80)).default([]),
  model: z.string().max(120).optional(),
  generatedBy: z.string().max(60).default("system"),
  expiresAt: z.string().datetime().optional(),
});
export type RecordInsightInput = z.infer<typeof recordInsightSchema>;

export const listInsightsSchema = z.object({
  module: moduleEnum.optional(),
  status: statusEnum.optional(),
  entityId: uuid.optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type ListInsightsInput = z.infer<typeof listInsightsSchema>;

export const decideInsightSchema = z.object({
  id: uuid,
  status: statusEnum,
});

/* ---------------- Recommend ---------------- */

export const recordRecommendationSchema = z.object({
  module: moduleEnum,
  insightId: uuid.optional(),
  recommendationKey: z.string().max(120).optional(),
  title: z.string().min(3).max(200),
  rationale: z.string().min(3).max(4000),
  suggestedAction: z.string().max(500).optional(),
  actionType: z.string().max(80).optional(),
  actionPayload: z.record(z.string(), z.unknown()).default({}),
  expectedImpact: z.string().max(300).optional(),
  impactValue: z.number().optional(),
  impactUnit: z.string().max(30).optional(),
  /** Why the core said this — signal keys / heuristics behind the recommendation. */
  reasoningSources: z.array(z.string().max(80)).default([]),
  priority: z.number().int().min(1).max(5).default(3),
  confidence: confidence.default(0.5),
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
  expiresAt: z.string().datetime().optional(),
});
export type RecordRecommendationInput = z.infer<typeof recordRecommendationSchema>;

export const listRecommendationsSchema = z.object({
  module: moduleEnum.optional(),
  status: statusEnum.optional(),
  entityId: uuid.optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type ListRecommendationsInput = z.infer<typeof listRecommendationsSchema>;

export const decideRecommendationSchema = z.object({
  id: uuid,
  decision: z.enum(["accepted", "dismissed", "reviewing"]),
  note: z.string().max(1000).optional(),
});
export type DecideRecommendationInput = z.infer<typeof decideRecommendationSchema>;

/* ---------------- Predict ---------------- */

export const recordPredictionSchema = z.object({
  module: moduleEnum,
  predictionKey: z.string().min(2).max(120),
  label: z.string().max(200).optional(),
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
  horizonDays: z.number().int().min(0).max(730).optional(),
  targetDate: z.string().optional(),
  predictedValue: z.number().optional(),
  predictedText: z.string().max(500).optional(),
  lowerBound: z.number().optional(),
  upperBound: z.number().optional(),
  unit: z.string().max(30).optional(),
  confidence: confidence.default(0.5),
  model: z.string().max(120).optional(),
  inputs: z.record(z.string(), z.unknown()).default({}),
});
export type RecordPredictionInput = z.infer<typeof recordPredictionSchema>;

export const listPredictionsSchema = z.object({
  module: moduleEnum.optional(),
  predictionKey: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type ListPredictionsInput = z.infer<typeof listPredictionsSchema>;

export const scorePredictionSchema = z.object({
  id: uuid,
  actualValue: z.number(),
});

/* ---------------- Act ---------------- */

export const proposeActionSchema = z.object({
  module: moduleEnum,
  recommendationId: uuid.optional(),
  actionType: z.string().min(2).max(80),
  title: z.string().max(200).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
  automated: z.boolean().default(false),
  requiresApproval: z.boolean().default(true),
  dedupeKey: z.string().max(200).optional(),
});
export type ProposeActionInput = z.infer<typeof proposeActionSchema>;

export const listActionsSchema = z.object({
  module: moduleEnum.optional(),
  status: z.enum(INTEL_ACTION_STATUSES).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type ListActionsInput = z.infer<typeof listActionsSchema>;

export const transitionActionSchema = z.object({
  id: uuid,
  status: z.enum(INTEL_ACTION_STATUSES),
  result: z.record(z.string(), z.unknown()).optional(),
  errorMessage: z.string().max(1000).optional(),
});
export type TransitionActionInput = z.infer<typeof transitionActionSchema>;

/* ---------------- Learn: memory + feedback ---------------- */

export const rememberSchema = z.object({
  scope: z.enum(INTEL_MEMORY_SCOPES).default("property"),
  scopeId: uuid.optional(),
  module: moduleEnum.optional(),
  memoryKey: z.string().min(2).max(120),
  memoryValue: z.string().min(1).max(4000),
  memoryType: z.string().max(60).default("fact"),
  /**
   * Memory hierarchy:
   *  observed  — facts ("occupancy was 78% last August")
   *  learned   — patterns ("August performs strongly when marketed 30 days ahead")
   *  strategic — management preference ("avoid heavy discounting")
   */
  memoryTier: z.enum(["observed", "learned", "strategic"]).default("observed"),
  confidence: confidence.default(0.5),
  source: z.string().max(60).default("system"),
  sourceEventId: uuid.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  expiresAt: z.string().datetime().optional(),
});
export type RememberInput = z.infer<typeof rememberSchema>;

export const recallSchema = z.object({
  scope: z.enum(INTEL_MEMORY_SCOPES).optional(),
  scopeId: uuid.optional(),
  module: moduleEnum.optional(),
  status: statusEnum.optional(),
  memoryTier: z.enum(["observed", "learned", "strategic"]).optional(),
  /** Only approved memories are safe to feed into reasoning by default. */
  approvedOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(25),
});
export type RecallInput = z.infer<typeof recallSchema>;

export const reviewMemorySchema = z.object({
  id: uuid,
  status: statusEnum,
  memoryValue: z.string().min(1).max(4000).optional(),
});
export type ReviewMemoryInput = z.infer<typeof reviewMemorySchema>;

export const submitFeedbackSchema = z.object({
  subjectType: z.enum(["insight", "recommendation", "prediction", "action", "memory"]),
  subjectId: uuid,
  module: moduleEnum.optional(),
  stage: z.enum(INTEL_STAGES).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  useful: z.boolean().optional(),
  correction: z.string().max(4000).optional(),
  comment: z.string().max(2000).optional(),
});
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;

/* ---------------- Row shapes returned to the UI ---------------- */

export interface IntelEventRow {
  id: string;
  module: IntelModule;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  severity: IntelSeverity;
  source: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  processed_at: string | null;
}

export interface IntelInsightRow {
  id: string;
  module: IntelModule;
  title: string;
  summary: string;
  severity: IntelSeverity;
  importance: number;
  confidence: number;
  status: IntelStatus;
  created_at: string;
}

export interface IntelRecommendationRow {
  id: string;
  module: IntelModule;
  title: string;
  rationale: string;
  suggested_action: string | null;
  expected_impact: string | null;
  priority: number;
  confidence: number;
  status: IntelStatus;
  created_at: string;
}

/** Registration contract for a module plugging into the Intelligence Core. */
export interface IntelligenceProvider {
  module: IntelModule;
  label: string;
  /** Stages this provider currently participates in. */
  stages: readonly IntelStage[];
  /** Event types the provider emits into the core. */
  emits?: readonly string[];
  /** Action types the provider is able to execute. */
  handles?: readonly string[];
}