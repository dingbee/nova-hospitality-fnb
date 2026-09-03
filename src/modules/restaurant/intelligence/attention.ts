/**
 * I14 "NOVA OPERATIONAL INTELLIGENCE" — pure attention/correlation/change
 * primitives. No I/O, no AI. Every function here only reprojects numbers
 * ALREADY computed by the existing menu/inventory/kitchen/purchasing
 * engines and the existing restaurant decision engine — it never
 * recomputes a metric, never invents a weight, and never claims causation.
 *
 * Reused, not reinvented:
 * - Decision.riskLevel / Decision.confidence (restaurantDecisionEngine.ts's
 *   own riskLevelFor) are the ONLY severity signal used for ranking here.
 * - Each engine's own period-over-period fields (MenuItemIntelligence's
 *   trendPercent, KitchenIntelligence's trendPercent, WastageTrend's
 *   changePercent, PurchasingIntelligence's spendChangePercent) are the
 *   ONLY "what changed" signal used here — this module does not compare
 *   raw tables itself.
 * - RestaurantFinding.facts.inventoryItemId / facts.menuItemId (already
 *   populated by findings.ts for every finding kind) are the ONLY link
 *   used to correlate signals across domains — never a name match, never
 *   an invented relationship.
 */
import type { Decision } from "@/modules/intelligence/decisions/decision.types";
import type { RestaurantRole } from "../core/contracts";
import type { RestaurantFinding, RestaurantStoredDecision } from "../decisions/decision.types";
import type {
  InventoryIntelligence,
  KitchenIntelligence,
  MenuIntelligence,
  PurchasingIntelligence,
} from "./types";

/** Same five buckets Decision.riskLevel already uses — no new vocabulary. */
const RISK_RANK: Record<Decision["riskLevel"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/**
 * Total order over stored decisions for "what matters right now": riskLevel
 * first (the engine's own severity classification), confidence as the
 * tiebreaker (the engine's own certainty in its recommendation). Neither
 * value is computed here — both already exist on every Decision.
 */
export function rankByAttention<T extends { riskLevel: Decision["riskLevel"]; confidence: number }>(
  decisions: T[],
): T[] {
  return [...decisions].sort((a, b) => {
    const riskDiff = RISK_RANK[b.riskLevel] - RISK_RANK[a.riskLevel];
    if (riskDiff !== 0) return riskDiff;
    return b.confidence - a.confidence;
  });
}

export interface PriorityItem {
  key: string;
  title: string;
  riskLevel: Decision["riskLevel"];
  confidence: number;
  status: Decision["status"];
  /** Decision.trigger — what is happening. */
  what: string;
  /** Decision.reasoning.whyItMatters. */
  why: string;
  /** Decision.evidence, unmodified. */
  evidence: Array<{ label: string; value: string }>;
  /** Decision.reasoning.whatIsLikely — the engine's own forward statement, never presented as a fact. */
  impact: string;
  /** Decision.reasoning.whatHappensNext[0] when a recommended option exists. */
  recommendedNextStep: string | null;
  /** True only when this decision already has an action beyond "proposed" — I14 must never re-recommend what's already in motion (spec section 30/31). */
  hasExistingAction: boolean;
}

/**
 * Top-N decisions for the "attention" section of a briefing. Only ever
 * reprojects existing Decision fields — every string here is copied
 * verbatim from a field the decision engine already populated.
 */
export function topPriorities(decisions: RestaurantStoredDecision[], limit = 5): PriorityItem[] {
  return rankByAttention(decisions)
    .slice(0, limit)
    .map((d) => ({
      key: d.key,
      title: d.title,
      riskLevel: d.riskLevel,
      confidence: d.confidence,
      status: d.status,
      what: d.trigger,
      why: d.reasoning.whyItMatters,
      evidence: d.evidence,
      impact: d.reasoning.whatIsLikely,
      recommendedNextStep: d.reasoning.whatHappensNext[0] ?? null,
      hasExistingAction: d.action != null,
    }));
}

export interface ChangeItem {
  domain: "menu" | "inventory" | "kitchen" | "purchasing";
  subject: string;
  /** Always "observed" — every ChangeItem is a real percent-change field an engine already computed, never an inference. */
  kind: "observed";
  changePercent: number;
  direction: "up" | "down";
  statement: string;
}

/**
 * The threshold below which a period-over-period move is treated as noise,
 * not a material change worth surfacing. 15 percentage points is the same
 * order of magnitude this codebase already uses elsewhere as a materiality
 * bar for restaurant metrics (e.g. the menu engine's own decline/promote
 * classification bands) — documented here explicitly per spec section 4:
 * "every weighting must be justified, deterministic, explainable, tested."
 */
export const MATERIAL_CHANGE_THRESHOLD_PERCENT = 15;

/**
 * Walks the period-over-period fields the four engines already compute and
 * returns only the moves that clear the materiality bar — this function
 * computes no percentage itself, it only filters and labels ones that
 * already exist on the engine outputs.
 */
export function detectMaterialChanges(engines: {
  /** Only `name`/`trendPercent` are read — accepts either the full MenuItemIntelligence or any compact projection of it (e.g. Staff Ask NOVA's bounded grounding context). */
  menu?: { declining: Array<{ name: string; trendPercent: number | null }> };
  inventory?: { wastage: Pick<InventoryIntelligence["wastage"], "changePercent"> };
  kitchen?: { trendPercent: KitchenIntelligence["trendPercent"] };
  purchasing?: { spendChangePercent: PurchasingIntelligence["spendChangePercent"] };
}): ChangeItem[] {
  const changes: ChangeItem[] = [];

  for (const item of engines.menu?.declining ?? []) {
    if (
      item.trendPercent == null ||
      Math.abs(item.trendPercent) < MATERIAL_CHANGE_THRESHOLD_PERCENT
    )
      continue;
    changes.push({
      domain: "menu",
      subject: item.name,
      kind: "observed",
      changePercent: item.trendPercent,
      direction: item.trendPercent >= 0 ? "up" : "down",
      statement: `${item.name} sales are ${item.trendPercent >= 0 ? "up" : "down"} ${Math.abs(item.trendPercent)}% vs the prior window.`,
    });
  }

  const wastage = engines.inventory?.wastage;
  if (
    wastage?.changePercent != null &&
    Math.abs(wastage.changePercent) >= MATERIAL_CHANGE_THRESHOLD_PERCENT
  ) {
    changes.push({
      domain: "inventory",
      subject: "Wastage",
      kind: "observed",
      changePercent: wastage.changePercent,
      direction: wastage.changePercent >= 0 ? "up" : "down",
      statement: `Wastage cost is ${wastage.changePercent >= 0 ? "up" : "down"} ${Math.abs(wastage.changePercent)}% vs the previous period.`,
    });
  }

  const kitchenTrend = engines.kitchen?.trendPercent;
  if (kitchenTrend != null && Math.abs(kitchenTrend) >= MATERIAL_CHANGE_THRESHOLD_PERCENT) {
    changes.push({
      domain: "kitchen",
      subject: "Average prep time",
      kind: "observed",
      changePercent: kitchenTrend,
      direction: kitchenTrend >= 0 ? "up" : "down",
      statement: `Average kitchen prep time is ${kitchenTrend >= 0 ? "up" : "down"} ${Math.abs(kitchenTrend)}% vs the prior window.`,
    });
  }

  const spendChange = engines.purchasing?.spendChangePercent;
  if (spendChange != null && Math.abs(spendChange) >= MATERIAL_CHANGE_THRESHOLD_PERCENT) {
    changes.push({
      domain: "purchasing",
      subject: "Purchasing spend",
      kind: "observed",
      changePercent: spendChange,
      direction: spendChange >= 0 ? "up" : "down",
      statement: `Expected monthly purchasing spend is ${spendChange >= 0 ? "up" : "down"} ${Math.abs(spendChange)}% vs the previous month.`,
    });
  }

  return rankByChangeMagnitude(changes);
}

function rankByChangeMagnitude(changes: ChangeItem[]): ChangeItem[] {
  return [...changes].sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
}

export interface Correlation {
  entityId: string;
  entityLabel: "inventory_item" | "menu_item";
  findingKinds: RestaurantFinding["kind"][];
  /** Always "inferred" — this is a co-occurrence across findings that share the same real entity id, never a claimed cause. */
  type: "inferred";
  statement: string;
  evidence: string[];
}

/**
 * The ONLY cross-domain correlation this module produces: two or more
 * findings of DIFFERENT kinds that share the same real inventory_item_id
 * or menu_item_id (already populated in RestaurantFinding.facts by
 * findings.ts for every finding kind — never a name match, never a
 * recipe-inferred link this module invents). Language is deliberately
 * "coincides with" / "may be contributing to" — never "caused by"
 * (spec section 7: causality discipline).
 */
export function correlateFindingsByEntity(findings: RestaurantFinding[]): Correlation[] {
  const byInventoryItem = new Map<string, RestaurantFinding[]>();
  const byMenuItem = new Map<string, RestaurantFinding[]>();

  for (const f of findings) {
    const invId = f.facts["inventoryItemId"];
    if (typeof invId === "string" && invId) {
      const list = byInventoryItem.get(invId) ?? [];
      list.push(f);
      byInventoryItem.set(invId, list);
    }
    const menuId = f.facts["menuItemId"];
    if (typeof menuId === "string" && menuId) {
      const list = byMenuItem.get(menuId) ?? [];
      list.push(f);
      byMenuItem.set(menuId, list);
    }
  }

  const correlations: Correlation[] = [];

  for (const [entityId, group] of byInventoryItem) {
    const kinds = [...new Set(group.map((f) => f.kind))];
    if (kinds.length < 2) continue;
    correlations.push({
      entityId,
      entityLabel: "inventory_item",
      findingKinds: kinds,
      type: "inferred",
      statement: `${group[0].subject}: ${group.map((f) => f.headline).join(" This coincides with: ")}`,
      evidence: group.map((f) => f.headline),
    });
  }

  for (const [entityId, group] of byMenuItem) {
    const kinds = [...new Set(group.map((f) => f.kind))];
    if (kinds.length < 2) continue;
    correlations.push({
      entityId,
      entityLabel: "menu_item",
      findingKinds: kinds,
      type: "inferred",
      statement: `${group[0].subject}: ${group.map((f) => f.headline).join(" This coincides with: ")}`,
      evidence: group.map((f) => f.headline),
    });
  }

  return correlations;
}

/**
 * Role-aware intelligence (spec section 10-11): NOVA must adapt WHICH
 * sections of the grounding context a role sees, gated server-side —
 * never merely by a prompt instruction. This reuses the exact
 * `intelligence.read` capability check already in front of Staff Ask NOVA
 * (a role reaching this function has already passed that gate); it only
 * decides which of the already-computed context sections that role's own
 * job actually needs, matching the worked table in the I14 spec section 10.
 * Role != execution authority — this never grants any write capability,
 * it only bounds what read-only context is handed to the model.
 */
export type ContextSection =
  "sales" | "menu" | "inventory" | "kitchen" | "purchasing" | "decisions";

const ALL_SECTIONS: ContextSection[] = [
  "sales",
  "menu",
  "inventory",
  "kitchen",
  "purchasing",
  "decisions",
];

const SECTIONS_BY_ROLE: Partial<Record<RestaurantRole, ContextSection[]>> = {
  owner: ALL_SECTIONS,
  general_manager: ALL_SECTIONS,
  restaurant_manager: ["sales", "kitchen", "inventory", "purchasing", "decisions"],
  chef: ["kitchen", "inventory", "menu", "decisions"],
  kitchen_manager: ["kitchen", "inventory", "menu", "decisions"],
  inventory_manager: ["inventory", "purchasing", "decisions"],
  purchasing_officer: ["inventory", "purchasing", "decisions"],
  accountant: ["sales", "menu", "inventory", "purchasing", "decisions"],
  bartender: ["inventory", "kitchen", "decisions"],
};

/**
 * Sections visible to a role. A role with no explicit mapping (e.g.
 * "viewer", which does not hold `intelligence.read` at all today) gets
 * nothing — fail closed, never fail open to the full context.
 */
export function contextSectionsForRole(role: RestaurantRole): ContextSection[] {
  return SECTIONS_BY_ROLE[role] ?? [];
}

/**
 * Applies contextSectionsForRole to a built context object, dropping any
 * section the role isn't entitled to. Sections outside ContextSection
 * (generatedAt, windowDays, briefing) are never gated — they carry no
 * domain-specific financial/operational data by themselves.
 */
export function trimContextForRoles<T extends Partial<Record<ContextSection, unknown>>>(
  context: T,
  roles: RestaurantRole[],
): T {
  const allowed = new Set<ContextSection>(roles.flatMap(contextSectionsForRole));
  const trimmed = { ...context };
  for (const section of ALL_SECTIONS) {
    if (!allowed.has(section)) delete trimmed[section];
  }
  return trimmed;
}
