/**
 * Reusable catalog item matching — one engine, every caller.
 *
 * O6's receiving basket needs it ("Coke 500 ML" typed or scanned should
 * find "Coca-Cola 500ml Bottle" rather than create a duplicate), and it is
 * built to be the same engine a future Import Studio reuses for exactly
 * the same problem at bulk scale — not a second implementation of it.
 *
 * The fuzzy name scoring itself is not reinvented here: it reuses
 * ../recipes/mapping.ts's tokenizer and confidence tiers unchanged (already
 * relied on by recipe gap-analysis/import), and only adds the identity
 * signals a receiving flow actually has that a legacy recipe book text
 * never did — an exact barcode, SKU or supplier SKU, each of which outranks
 * a fuzzy name match outright rather than blending into its score.
 *
 * Pure and DB-free: callers fetch candidates, this module only scores and
 * ranks them. Nothing here resolves, creates or writes anything — a human
 * confirms every non-exact match, same as mapping.ts's own contract.
 */
import { confidenceFor, ingredientKey, tokens, type MappingConfidence } from "../recipes/mapping";

export interface CatalogMatchCandidate {
  id: string;
  sku: string;
  name: string;
  barcode?: string | null;
  brand?: string | null;
  categoryName?: string | null;
  /** This candidate's own supplier-specific code(s), when known to the caller. */
  supplierSkus?: readonly string[];
}

export interface MatchQuery {
  /** A scanned or typed barcode — the strongest possible signal when it hits. */
  barcode?: string | null;
  /** A NOVA SKU, e.g. typed directly or carried over from a prior import. */
  sku?: string | null;
  /** The vendor's own code for this line, e.g. from a delivery note. */
  supplierSku?: string | null;
  /** Free-text name, e.g. "Coke 500 ML" from a scanned document or manual entry. */
  name?: string | null;
}

export interface CatalogMatchResult {
  candidate: CatalogMatchCandidate;
  score: number;
  confidence: MappingConfidence;
  evidence: string[];
}

function normalizedEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** Fuzzy name overlap only — the same scoring recipes/mapping.ts's scoreCandidate uses for its name signal. */
function nameScore(
  queryName: string | null | undefined,
  candidateName: string,
): { score: number; evidence: string[] } {
  if (!queryName) return { score: 0, evidence: [] };
  if (ingredientKey(queryName) === ingredientKey(candidateName)) {
    return { score: 1, evidence: ["Name matches exactly (normalized)."] };
  }
  const q = tokens(queryName);
  const c = new Set(tokens(candidateName));
  const overlap = q.filter((t) => c.has(t));
  const score = q.length === 0 ? 0 : overlap.length / q.length;
  return {
    score,
    evidence: overlap.length > 0 ? [`Name overlap: ${overlap.join(", ")}.`] : [],
  };
}

/**
 * Scores one candidate against a query. Exact identity signals (barcode,
 * SKU, supplier SKU) win outright at score 1 — a scanned barcode that hits
 * is never second-guessed by a weaker name score. Falls back to fuzzy name
 * overlap only when nothing exact is available or nothing exact matched.
 */
export function scoreCatalogMatch(
  query: MatchQuery,
  candidate: CatalogMatchCandidate,
): CatalogMatchResult {
  if (normalizedEquals(query.barcode, candidate.barcode)) {
    return {
      candidate,
      score: 1,
      confidence: "exact",
      evidence: [`Barcode ${candidate.barcode} matches exactly.`],
    };
  }
  if (normalizedEquals(query.sku, candidate.sku)) {
    return {
      candidate,
      score: 1,
      confidence: "exact",
      evidence: [`SKU ${candidate.sku} matches exactly.`],
    };
  }
  if (
    query.supplierSku &&
    candidate.supplierSkus?.some((s) => normalizedEquals(query.supplierSku, s))
  ) {
    return {
      candidate,
      score: 0.98,
      confidence: "exact",
      evidence: [`Supplier code ${query.supplierSku} is on file for this item.`],
    };
  }

  const { score, evidence } = nameScore(query.name, candidate.name);
  return { candidate, score: Number(score.toFixed(4)), confidence: confidenceFor(score), evidence };
}

/**
 * Ranks every candidate against a query, best first. Ties on score keep
 * their original candidate order (a stable sort), so callers presenting a
 * candidate list see deterministic results across repeated searches.
 */
export function matchCatalogItem(
  query: MatchQuery,
  candidates: readonly CatalogMatchCandidate[],
  opts: { limit?: number; minScore?: number } = {},
): CatalogMatchResult[] {
  const minScore = opts.minScore ?? 0;
  return candidates
    .map((c) => scoreCatalogMatch(query, c))
    .filter((r) => r.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 10);
}
