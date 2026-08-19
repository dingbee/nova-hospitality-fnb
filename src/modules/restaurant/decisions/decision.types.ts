/**
 * Phase 4 — Restaurant Decision Intelligence (browser-safe contracts).
 *
 *   Finding → Prediction → Options → Evaluate → Decide → Plan
 *      → Approval → Action → Outcome → Learning
 *
 * Findings come from Phase 3 (menu / inventory / kitchen / purchasing
 * intelligence). Everything downstream reuses the Intelligence Core decision
 * types so restaurant decisions land in the same board, ledger and governance
 * flow as every other platform decision.
 */
import { z } from "zod";
import type { Decision, StoredDecision } from "@/modules/intelligence/decisions/decision.types";
import type { InsightSeverity } from "../intelligence/types";

export const RESTAURANT_FINDING_KINDS = [
  "menu_margin",
  "inventory_shortage",
  "wastage_spike",
  "kitchen_capacity",
  "purchasing_replenishment",
  "supplier_risk",
] as const;
export type RestaurantFindingKind = (typeof RESTAURANT_FINDING_KINDS)[number];

export const RESTAURANT_FINDING_LABEL: Record<RestaurantFindingKind, string> = {
  menu_margin: "Menu margin",
  inventory_shortage: "Inventory shortage",
  wastage_spike: "Wastage",
  kitchen_capacity: "Kitchen capacity",
  purchasing_replenishment: "Purchasing",
  supplier_risk: "Supplier risk",
};

/** What the prediction layer expects to happen if nothing is done. */
export interface RestaurantPrediction {
  key: string;
  statement: string;
  value: number | null;
  unit: string;
  horizonDays: number;
  confidence: number;
  direction: "up" | "down" | "flat";
}

/** A Phase 3 finding, promoted into a decision candidate. */
export interface RestaurantFinding {
  key: string;
  kind: RestaurantFindingKind;
  severity: InsightSeverity;
  subject: string;
  headline: string;
  detail: string;
  metric: string | null;
  evidence: Array<{ label: string; value: string }>;
  prediction: RestaurantPrediction;
  /** Facts the option catalogue reads when scoring, e.g. star dish, no supplier. */
  facts: Record<string, string | number | boolean | null>;
}

export interface RestaurantDecisionCandidate {
  finding: RestaurantFinding;
  decision: Decision;
}

export interface RestaurantDecisionBoard {
  generated_at: string;
  tenant_id: string;
  window_days: number;
  headline: string;
  findings: RestaurantFinding[];
  candidates: RestaurantDecisionCandidate[];
  stored: StoredDecision[];
}

export interface RestaurantDecisionPassResult {
  findings: number;
  decisionsEvaluated: number;
  decisionsRecorded: number;
  plansCreated: number;
  headline: string;
}

export const restaurantDecisionBoardSchema = z.object({
  tenantId: z.string().uuid(),
  windowDays: z.number().int().min(7).max(120).default(30),
  includeStored: z.boolean().default(true),
});
export type RestaurantDecisionBoardInput = z.infer<typeof restaurantDecisionBoardSchema>;

export const runRestaurantDecisionPassSchema = z.object({
  tenantId: z.string().uuid(),
  windowDays: z.number().int().min(7).max(120).default(30),
  persist: z.boolean().default(true),
});
export type RunRestaurantDecisionPassInput = z.infer<typeof runRestaurantDecisionPassSchema>;