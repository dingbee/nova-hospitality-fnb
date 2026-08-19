/**
 * Ingredient → catalog matching, as *evidence*, never as a decision.
 *
 * The legacy recipe books name ingredients the way a chef speaks ("beef fillet",
 * "cooking oil"), while the master catalog names them the way a storekeeper
 * buys them ("Beef Fillet 1kg", "Sunflower Cooking Oil 5L"). This module scores
 * that resemblance and explains itself, so an administrator can judge it. It
 * deliberately returns candidates only — nothing here maps, creates or resolves
 * anything on its own.
 */

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "with",
  "for",
  "in",
  "on",
  "to",
  "fresh",
  "raw",
  "whole",
  "per",
  "kg",
  "g",
  "l",
  "ml",
  "pcs",
  "pc",
  "piece",
  "pieces",
  "each",
  "ea",
  "pack",
  "packet",
  "bottle",
  "tin",
  "box",
  "bag",
  "jar",
  "carton",
]);

/** Stable identity for a piece of legacy ingredient text. */
export function ingredientKey(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(text: string | null | undefined): string[] {
  return ingredientKey(text)
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function singular(t: string) {
  if (t.length > 3 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

export type MappingConfidence = "exact" | "high" | "medium" | "low";

export interface CandidateScore {
  score: number;
  confidence: MappingConfidence;
  evidence: string[];
}

export interface ScoreInput {
  ingredientName: string | null;
  candidateSku: string | null;
  item: { sku: string; name: string; subcategory?: string | null; categoryName?: string | null };
  /** Confirmed previously by a human for this same ingredient text. */
  previouslyConfirmed?: boolean;
  /** Explicitly rejected previously by a human for this ingredient text. */
  previouslyRejected?: boolean;
  unitCompatible?: boolean | null;
}

export function confidenceFor(score: number): MappingConfidence {
  if (score >= 0.999) return "exact";
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

/**
 * Score one catalog item against one legacy ingredient. Human decisions
 * outrank text similarity, and the workbook's own candidate SKU outranks
 * anything the matcher infers by itself.
 */
export function scoreCandidate(input: ScoreInput): CandidateScore {
  const evidence: string[] = [];

  if (input.previouslyRejected) {
    return {
      score: 0,
      confidence: "low",
      evidence: ["Previously rejected for this ingredient by an administrator."],
    };
  }

  const ing = tokens(input.ingredientName).map(singular);
  const item = new Set([
    ...tokens(input.item.name).map(singular),
    ...tokens(input.item.subcategory).map(singular),
    ...tokens(input.item.categoryName).map(singular),
  ]);

  const overlap = ing.filter((t) => item.has(t));
  let score = ing.length === 0 ? 0 : overlap.length / ing.length;
  if (overlap.length > 0) evidence.push(`Name overlap: ${overlap.join(", ")}.`);
  if (ingredientKey(input.ingredientName) === ingredientKey(input.item.name)) {
    score = 1;
    evidence.push("Ingredient text matches the catalog item name exactly.");
  }

  if (input.candidateSku && input.candidateSku.toUpperCase() === input.item.sku.toUpperCase()) {
    score = Math.max(score, 0.95);
    evidence.push(`Source workbook proposed ${input.item.sku} for this line.`);
  }
  if (input.previouslyConfirmed) {
    score = Math.max(score, 0.9);
    evidence.push(
      "An administrator previously confirmed this catalog item for the same ingredient text.",
    );
  }
  if (input.unitCompatible === false) {
    score = Math.min(score, 0.5);
    evidence.push("Recipe unit and catalog stock unit measure different things.");
  } else if (input.unitCompatible === true) {
    evidence.push("Recipe unit is convertible to the catalog stock unit.");
  } else if (input.unitCompatible === null) {
    evidence.push("Recipe unit is unknown, so unit compatibility cannot be established.");
  }

  return {
    score: Number(Math.min(score, 1).toFixed(4)),
    confidence: confidenceFor(score),
    evidence,
  };
}
