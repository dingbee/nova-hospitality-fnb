/**
 * Recipe → catalog gap analysis: pure classification and suggestion logic.
 *
 * This module decides *nothing* about the data. It reads the evidence already
 * present (mapping state, units, candidate scores, pack labels) and names the
 * gap so a person can close it. It is deliberately property-independent: no
 * ingredient, category or supplier of any particular business appears here.
 */

export type GapClass =
  | "VERIFIED_MATCH"
  | "MATCH_REQUIRES_REVIEW"
  | "MISSING_CATALOG_ITEM"
  | "UNIT_MISMATCH"
  | "MISSING_STOCK_UNIT"
  | "AMBIGUOUS";

export const GAP_CLASSES: GapClass[] = [
  "VERIFIED_MATCH",
  "MATCH_REQUIRES_REVIEW",
  "MISSING_CATALOG_ITEM",
  "UNIT_MISMATCH",
  "MISSING_STOCK_UNIT",
  "AMBIGUOUS",
];

export const GAP_CLASS_LABELS: Record<GapClass, string> = {
  VERIFIED_MATCH: "Verified match",
  MATCH_REQUIRES_REVIEW: "Match requires review",
  MISSING_CATALOG_ITEM: "Missing catalog item",
  UNIT_MISMATCH: "Unit mismatch",
  MISSING_STOCK_UNIT: "Missing stock unit",
  AMBIGUOUS: "Ambiguous",
};

export interface ClassifyLineInput {
  /** Persisted mapping state of the recipe line. */
  mappingStatus: string | null;
  /** The catalog item this line currently points at, if any. */
  mapped: { hasStockUnit: boolean; stockUnitDimension: string | null; hasCostBasis: boolean } | null;
  /** Dimension of the unit the recipe states, when it could be resolved. */
  lineUnitDimension: string | null;
  /** Whether the recipe stated a unit at all. */
  lineUnitStated: boolean;
  /** Ranked candidate scores for an unmapped line, highest first. */
  candidateScores: number[];
}

export interface LineClassification {
  classification: GapClass;
  reason: string;
  /** Only a verified, costed match can contribute to a real recipe cost. */
  costable: boolean;
}

/** Below this, a suggestion is too weak to be treated as a candidate at all. */
const CANDIDATE_FLOOR = 0.3;
/** A single clear leader may be proposed to a human for confirmation. */
const CLEAR_LEADER = 0.6;
/** Two candidates this close together are indistinguishable without judgement. */
const TIE_WINDOW = 0.12;

export function classifyLine(input: ClassifyLineInput): LineClassification {
  const mapped = input.mapped;

  if (!mapped) {
    const [top = 0, second = 0] = input.candidateScores;
    if (top < CANDIDATE_FLOOR) {
      return {
        classification: "MISSING_CATALOG_ITEM",
        reason: "No catalog item resembles this ingredient closely enough to be a candidate.",
        costable: false,
      };
    }
    if (top >= CLEAR_LEADER && top - second > TIE_WINDOW) {
      return {
        classification: "MATCH_REQUIRES_REVIEW",
        reason: "One clear catalog candidate is proposed and awaits confirmation.",
        costable: false,
      };
    }
    return {
      classification: "AMBIGUOUS",
      reason: "Several catalog items match this ingredient about equally well.",
      costable: false,
    };
  }

  if (!mapped.hasStockUnit) {
    return {
      classification: "MISSING_STOCK_UNIT",
      reason: "The mapped catalog item has no stock unit recorded, so no quantity can be converted.",
      costable: false,
    };
  }
  if (!input.lineUnitStated || !input.lineUnitDimension) {
    return {
      classification: "MATCH_REQUIRES_REVIEW",
      reason: "The recipe does not state a unit that can be matched against the stock unit.",
      costable: false,
    };
  }
  if (input.lineUnitDimension !== mapped.stockUnitDimension) {
    return {
      classification: "UNIT_MISMATCH",
      reason: "The recipe unit and the catalog stock unit measure different things.",
      costable: false,
    };
  }
  if (input.mappingStatus !== "resolved") {
    return {
      classification: "MATCH_REQUIRES_REVIEW",
      reason: "The mapping is recorded but has not been confirmed as resolved.",
      costable: false,
    };
  }
  if (!mapped.hasCostBasis) {
    return {
      classification: "VERIFIED_MATCH",
      reason: "Mapped and unit-verified, but the catalog item carries no cost basis yet.",
      costable: false,
    };
  }
  return {
    classification: "VERIFIED_MATCH",
    reason: "Mapped to a catalog SKU with a compatible unit and a usable cost basis.",
    costable: true,
  };
}

export type CostingState = "COSTABLE" | "PARTIAL" | "NON_COSTABLE";

/**
 * A recipe is COSTABLE only when every single line is verified and costed.
 * Anything else is honest about being incomplete: PARTIAL when some lines are
 * costable, NON_COSTABLE when none are.
 */
export function costingState(lineCostable: boolean[]): CostingState {
  if (lineCostable.length === 0) return "NON_COSTABLE";
  if (lineCostable.every(Boolean)) return "COSTABLE";
  return lineCostable.some(Boolean) ? "PARTIAL" : "NON_COSTABLE";
}

/* ------------------------------------------------------------------ */
/* Suggestions — always accompanied by the reason, never auto-applied. */
/* ------------------------------------------------------------------ */

const MEASURE_UNITS: Record<string, string> = {
  kg: "mass",
  g: "mass",
  l: "volume",
  ml: "volume",
};

export interface StockUnitSuggestion {
  code: string | null;
  reason: string;
}

export interface StockUnitEvidence {
  purchaseUnitCode: string | null;
  packLabel: string | null;
  itemName: string | null;
  /** Unit codes the recipes actually measure this item in. */
  recipeUnitCodes: string[];
}

/** Parse a trailing or embedded measure such as "12 x 1L", "25kg", "700 ml". */
export function measureFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/g);
  if (!m || m.length === 0) return null;
  const last = m[m.length - 1].match(/(kg|g|ml|l)\b/);
  return last ? last[1] : null;
}

/**
 * Propose a stock unit from evidence that already exists. Returns `null` when
 * no reliable conversion exists — the item then stays UNRESOLVED rather than
 * being guessed into a number that would corrupt every future cost.
 */
export function suggestStockUnit(evidence: StockUnitEvidence): StockUnitSuggestion {
  const purchase = evidence.purchaseUnitCode?.toLowerCase() ?? null;
  if (purchase && purchase in MEASURE_UNITS) {
    return { code: purchase, reason: `Purchased by measure (${purchase}), so the stock unit is the same measure.` };
  }

  const fromPack = measureFromText(evidence.packLabel);
  if (fromPack) {
    return {
      code: fromPack,
      reason: `Pack size "${evidence.packLabel}" states a ${MEASURE_UNITS[fromPack]} measure.`,
    };
  }

  const recipeUnits = Array.from(
    new Set(evidence.recipeUnitCodes.map((c) => c.toLowerCase()).filter((c) => c in MEASURE_UNITS)),
  );
  const dimensions = new Set(recipeUnits.map((c) => MEASURE_UNITS[c]));
  if (recipeUnits.length > 0 && dimensions.size === 1) {
    return {
      code: recipeUnits.includes("g") ? "g" : recipeUnits.includes("ml") ? "ml" : recipeUnits[0],
      reason: `Recipes consistently measure this item in ${recipeUnits.join(", ")}.`,
    };
  }
  if (dimensions.size > 1) {
    return { code: null, reason: "Recipes measure this item in incompatible dimensions." };
  }

  const fromName = measureFromText(evidence.itemName);
  if (fromName) {
    return {
      code: fromName,
      reason: `The item name states a ${MEASURE_UNITS[fromName]} measure — confirm it describes the pack, not the brand.`,
    };
  }

  if (purchase) {
    return {
      code: null,
      reason: `Purchased by "${purchase}" with no stated pack measure — no reliable conversion exists.`,
    };
  }
  return { code: null, reason: "No purchase unit, pack size or recipe usage to infer a stock unit from." };
}

export interface MissingItemSuggestion {
  stockUnitCode: string | null;
  stockUnitReason: string;
}

/** Propose the stock unit for an ingredient that has no catalog item at all. */
export function suggestUnitForMissingItem(recipeUnitCodes: string[]): MissingItemSuggestion {
  const units = Array.from(
    new Set(recipeUnitCodes.map((c) => c?.toLowerCase()).filter((c): c is string => Boolean(c))),
  );
  const measures = units.filter((c) => c in MEASURE_UNITS);
  const dimensions = new Set(measures.map((c) => MEASURE_UNITS[c]));
  if (measures.length > 0 && dimensions.size === 1) {
    return {
      stockUnitCode: measures.includes("g") ? "g" : measures.includes("ml") ? "ml" : measures[0],
      stockUnitReason: `Recipes measure this ingredient in ${measures.join(", ")}.`,
    };
  }
  if (dimensions.size > 1) {
    return {
      stockUnitCode: null,
      stockUnitReason: "Recipes measure this ingredient in incompatible dimensions — decide the stock unit deliberately.",
    };
  }
  if (units.length > 0) {
    return {
      stockUnitCode: "ea",
      stockUnitReason: `Recipes count this ingredient (${units.join(", ")}) rather than weighing or measuring it.`,
    };
  }
  return { stockUnitCode: null, stockUnitReason: "No recipe unit was stated for this ingredient." };
}

/**
 * Next SKU in an existing family. The SKU shape is inferred from the catalog
 * itself (prefix-domain-code-sequence) so no property's convention is baked in.
 */
export function nextSku(existingSkus: string[], prefix: string, domain: string, code: string): string {
  const family = `${prefix}-${domain}-${code}-`.toUpperCase();
  let max = 0;
  for (const sku of existingSkus) {
    const upper = sku.toUpperCase();
    if (!upper.startsWith(family)) continue;
    const n = Number(upper.slice(family.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${family}${String(max + 1).padStart(4, "0")}`;
}

/** The dominant prefix of a catalog, e.g. the "MTN" in "MTN-FNB-SAU-0001". */
export function catalogPrefix(existingSkus: string[], fallback = "SKU"): string {
  const counts = new Map<string, number>();
  for (const sku of existingSkus) {
    const parts = sku.split("-");
    if (parts.length < 4) continue;
    const p = parts[0].toUpperCase();
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [p, c] of counts) if (c > bestCount) [best, bestCount] = [p, c];
  return best;
}