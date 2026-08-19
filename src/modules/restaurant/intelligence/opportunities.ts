/**
 * Sprint 5.11 — inventory → menu opportunity scoring. Pure, no I/O.
 *
 * This layer produces *findings with evidence*. It never phrases a decision and
 * never writes anywhere. Confidence is derived from evidence quality only —
 * absent evidence lowers confidence, it is never rounded up.
 */

export const OPPORTUNITY_KINDS = [
  "overstock",
  "expiry_risk",
  "underutilised",
  "margin",
  "demand",
  "recipe",
  "new_menu",
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

export const OPPORTUNITY_LABEL: Record<OpportunityKind, string> = {
  overstock: "Overstock",
  expiry_risk: "Expiry risk",
  underutilised: "Underutilised inventory",
  margin: "Margin opportunity",
  demand: "Demand opportunity",
  recipe: "Dormant recipe",
  new_menu: "New menu candidate",
};

export type EvidenceStrength = "hard" | "soft" | "missing";

export interface Evidence {
  label: string;
  value: string;
  /** hard = measured fact, soft = inferred, missing = data unavailable. */
  strength: EvidenceStrength;
  weight: number;
}

export interface Opportunity {
  key: string;
  kind: OpportunityKind;
  title: string;
  summary: string;
  entityType: "restaurant_inventory_item" | "restaurant_menu_item" | "restaurant_recipe";
  entityId: string | null;
  evidence: Evidence[];
  /** null when there is not enough evidence to make a claim. */
  confidence: number | null;
  /** 0..100, used only for ordering. */
  priority: number;
  /** Operational blockers that must be resolved by a human first. */
  blockers: string[];
}

const HARD_MIN = 2;

/**
 * Confidence = weighted share of hard evidence, damped by missing evidence.
 * Fewer than two hard facts → null (unknown), never a manufactured number.
 */
export function deriveConfidence(evidence: Evidence[]): number | null {
  const hard = evidence.filter((e) => e.strength === "hard");
  if (hard.length < HARD_MIN) return null;
  const total = evidence.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return null;
  const hardWeight = hard.reduce((s, e) => s + e.weight, 0);
  const softWeight = evidence.filter((e) => e.strength === "soft").reduce((s, e) => s + e.weight * 0.5, 0);
  const raw = (hardWeight + softWeight) / total;
  return Number(Math.min(0.95, Math.max(0.05, raw)).toFixed(2));
}

/** Ordering score. Blocked opportunities are penalised, never silently dropped. */
export function derivePriority(
  kind: OpportunityKind,
  confidence: number | null,
  urgencyDays: number | null,
  blockers: string[],
): number {
  const base: Record<OpportunityKind, number> = {
    expiry_risk: 85,
    overstock: 65,
    margin: 60,
    demand: 55,
    recipe: 50,
    underutilised: 45,
    new_menu: 35,
  };
  let score = base[kind];
  if (confidence != null) score += confidence * 15;
  if (urgencyDays != null) score += Math.max(0, 10 - urgencyDays) * 2;
  score -= blockers.length * 12;
  return Math.round(Math.min(100, Math.max(0, score)));
}

export function coverRatio(quantity: number, dailyVelocity: number, targetCoverDays: number): number | null {
  if (dailyVelocity <= 0 || targetCoverDays <= 0) return null;
  return Number((quantity / (dailyVelocity * targetCoverDays)).toFixed(2));
}

export function daysUntil(dateIso: string | null, now = Date.now()): number | null {
  if (!dateIso) return null;
  const t = new Date(dateIso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - now) / 864e5);
}

/** Summarise a set of opportunities for the intelligence surface header. */
export function summariseOpportunities(list: Opportunity[]) {
  const byKind = new Map<OpportunityKind, number>();
  for (const o of list) byKind.set(o.kind, (byKind.get(o.kind) ?? 0) + 1);
  return {
    total: list.length,
    expiryDriven: byKind.get("expiry_risk") ?? 0,
    marginDriven: (byKind.get("margin") ?? 0) + (byKind.get("overstock") ?? 0),
    demandDriven: byKind.get("demand") ?? 0,
    recipeDriven: (byKind.get("recipe") ?? 0) + (byKind.get("new_menu") ?? 0),
  };
}