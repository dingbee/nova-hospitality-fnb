/**
 * I11 — pure, deterministic quantity/unit text extraction.
 *
 * Deliberately narrow: this only recognizes NUMBER + a known unit-shaped
 * word (kg, bottles, cartons, ...) — it never invents a conversion between
 * units (that is inventory/units.ts's job, and it is not invoked here —
 * see the I11 architectural verdict, point 11). A number with no
 * recognizable unit next to it (e.g. a guest count) is handled by the
 * separate parseGuestCount, so the two never get confused with each other.
 */

/**
 * Overlaps deliberately with recipes/mapping.ts's STOPWORDS list (which
 * already treats these same words as "unit noise" to ignore when fuzzy-
 * matching a name) — this file doesn't import that list since its purpose
 * here is the opposite (recognizing a unit, not discarding it), but the
 * vocabulary is intentionally the same restaurant-inventory unit words.
 */
const UNIT_WORDS = new Set([
  "kg",
  "kgs",
  "g",
  "gram",
  "grams",
  "l",
  "lt",
  "liter",
  "liters",
  "litre",
  "litres",
  "ml",
  "pc",
  "pcs",
  "piece",
  "pieces",
  "bottle",
  "bottles",
  "btl",
  "carton",
  "cartons",
  "box",
  "boxes",
  "bag",
  "bags",
  "jar",
  "jars",
  "tin",
  "tins",
  "case",
  "cases",
  "unit",
  "units",
  "crate",
  "crates",
  "pack",
  "packs",
  "packet",
  "packets",
  "ea",
  "each",
  "gal",
  "gallon",
  "gallons",
  "block",
  "blocks",
  "bucket",
  "buckets",
  "sack",
  "sacks",
]);

export interface QuantityMatch {
  /** The exact substring matched, e.g. "3kg" or "20 cartons". */
  raw: string;
  quantity: number;
  /** Lowercased unit word, e.g. "kg", "cartons". */
  unitText: string;
  /** Character offset of `raw` within the source text — used to pair a quantity with the entity text immediately following it. */
  index: number;
  /** Character offset immediately after `raw`. */
  endIndex: number;
}

const NUMBER_WORD_RE = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\b/g;

/** Finds every "<number><unit word>" occurrence in free text. Anything where the following word isn't a recognized unit is not returned here — see parseGuestCount for bare counts. */
export function parseItemQuantities(text: string): QuantityMatch[] {
  const matches: QuantityMatch[] = [];
  NUMBER_WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_WORD_RE.exec(text))) {
    const quantity = Number(m[1]);
    const unitText = m[2].toLowerCase();
    if (!Number.isFinite(quantity) || !UNIT_WORDS.has(unitText)) continue;
    matches.push({
      raw: m[0],
      quantity,
      unitText,
      index: m.index,
      endIndex: m.index + m[0].length,
    });
  }
  return matches;
}

const GUEST_COUNT_RE = /(\d+(?:\.\d+)?)\s+(?:[a-zA-Z]+\s+)?(guests?|covers?|people|pax|diners?)\b/i;

/** "40 lunch guests" -> { raw: "40 lunch guests", count: 40 } — a covers count, never confused with an item quantity. Tolerates one descriptor word ("lunch") between the number and the guest word. */
export function parseGuestCount(text: string): { raw: string; count: number } | null {
  const m = GUEST_COUNT_RE.exec(text);
  if (!m) return null;
  const count = Number(m[1]);
  if (!Number.isFinite(count)) return null;
  return { raw: m[0], count };
}

export interface UnitRowLike {
  id: string;
  code: string;
  name: string;
}

/** Exact code/name match only (case-insensitive) — never a fuzzy guess at which unit was meant. */
export function resolveUnitId(unitText: string, units: readonly UnitRowLike[]): string | null {
  const norm = unitText.trim().toLowerCase();
  if (!norm) return null;
  const hit = units.find((u) => u.code.toLowerCase() === norm || u.name.toLowerCase() === norm);
  return hit?.id ?? null;
}
