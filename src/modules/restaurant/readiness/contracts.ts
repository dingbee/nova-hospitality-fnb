/**
 * P13 — Configuration & Readiness Centre. Canonical readiness contract.
 *
 * One authoritative shape for "what's blocking go-live", reused by every
 * domain check in readiness.server.ts and by the UI. Nothing here stores
 * progress — every item is recomputed from live rows on every request (same
 * philosophy as P12's onboarding status and the Setup Workbench).
 */
import { z } from "zod";

export const READINESS_STATUSES = [
  "COMPLETE",
  "BLOCKED",
  "WARNING",
  "OPTIONAL",
  "NOT_APPLICABLE",
] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const READINESS_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "OPTIONAL"] as const;
export type ReadinessSeverity = (typeof READINESS_SEVERITIES)[number];

export const GO_LIVE_STATES = ["NOT_READY", "READY_FOR_TEST", "READY_FOR_GO_LIVE", "LIVE"] as const;
export type GoLiveState = (typeof GO_LIVE_STATES)[number];

/** Stable domain ids — the 18-step master setup sequence. */
export const READINESS_DOMAINS = [
  "business",
  "property",
  "outlet",
  "staff",
  "operating_model",
  "menu",
  "products",
  "recipes_costing",
  "pricing",
  "tax",
  "payments",
  "inventory",
  "suppliers_purchasing",
  "kitchen_bar",
  "tables_service",
  "guest_ordering",
  "fiscalisation",
  "final_check",
] as const;
export type ReadinessDomain = (typeof READINESS_DOMAINS)[number];

export interface ReadinessFixAction {
  label: string;
  to: string;
}

export interface ReadinessItem {
  domain: ReadinessDomain;
  status: ReadinessStatus;
  severity: ReadinessSeverity;
  title: string;
  /** Why this domain matters — plain operational language, no internals. */
  explanation: string;
  /** What "done" looks like. */
  requirement: string;
  /** What's actually there right now, in plain language. */
  currentState: string;
  /** Why it's blocked/warned, or null when there's nothing to say. */
  blocker: string | null;
  fixAction: ReadinessFixAction | null;
  /** Domain ids this one depends on, in the master sequence. */
  dependsOn: ReadinessDomain[];
  /** True when a genuine upstream dependency — not this domain's own data — is the reason it's blocked. */
  blockedByDependency: boolean;
}

export interface ReadinessReport {
  tenantId: string;
  generatedAt: string;
  items: ReadinessItem[];
  /** Weighted 0-100. CRITICAL/HIGH items dominate; OPTIONAL items are excluded. */
  progressPercent: number;
  goLiveState: GoLiveState;
  criticalBlockers: number;
  highBlockers: number;
  warnings: number;
  /** A real, non-configuration signal: has at least one order actually been paid? */
  hasRecordedTestSale: boolean;
  liveConfirmedAt: string | null;
  liveConfirmedBy: string | null;
}

export const getReadinessReportSchema = z.object({ tenantId: z.string().uuid() });
export const confirmGoLiveSchema = z.object({ tenantId: z.string().uuid() });
