/**
 * O7 Import Studio — normalization.
 *
 * Pure functions: turn a mapped row's raw text into typed values, and
 * resolve a unit label to one of the tenant's actual unit rows. Reuses
 * inventory/units.ts for the conversion arithmetic itself — this module only
 * adds the text-label -> unit-row lookup that arithmetic needs, and never
 * invents a conversion units.ts would refuse.
 *
 * An unresolved unit or an unparsable number is reported, never guessed.
 */
import type { UnitRow } from "../inventory/units";
import type { FieldMappingEntry } from "./domains";

/** Apply a saved column -> canonical field mapping to one raw row. Unmapped columns are dropped. */
export function applyMapping(
  mapping: readonly FieldMappingEntry[],
  rawRow: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mapping) {
    if (!m.canonicalField) continue;
    const value = rawRow[m.sourceColumn];
    if (value !== undefined && value !== "") out[m.canonicalField] = value;
  }
  return out;
}

/** Accepts "1,234.50", "1234.5", " 12 " — never a bare regex strip that would silently swallow a typo like "12kg". */
export function parseNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "available", "active", "in stock"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "unavailable", "inactive", "out of stock"]);

export function parseBoolean(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined) return null;
  const norm = raw.trim().toLowerCase();
  if (norm === "") return null;
  if (TRUE_WORDS.has(norm)) return true;
  if (FALSE_WORDS.has(norm)) return false;
  return null;
}

/** Normalized alias -> unit code. Only the common written variants — never a guess at an unfamiliar word. */
const UNIT_CODE_ALIASES: Record<string, string> = {
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  kgs: "kg",
  g: "g",
  gram: "g",
  grams: "g",
  gm: "g",
  l: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  ml: "ml",
  millilitre: "ml",
  millilitres: "ml",
  milliliter: "ml",
  milliliters: "ml",
  ea: "ea",
  each: "ea",
  pc: "ea",
  pcs: "ea",
  piece: "ea",
  pieces: "ea",
  unit: "ea",
  units: "ea",
  portion: "portion",
  portions: "portion",
};

export interface UnitResolution {
  status: "resolved" | "unknown";
  unit: UnitRow | null;
  raw: string | null;
}

/** Look up a raw unit label against the tenant's own unit rows — via a known alias, or the label itself as a code. */
export function resolveUnit(
  raw: string | null | undefined,
  units: readonly UnitRow[],
): UnitResolution {
  if (!raw || !raw.trim()) return { status: "unknown", unit: null, raw: raw ?? null };
  const norm = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const aliasCode = UNIT_CODE_ALIASES[norm];
  const match =
    (aliasCode && units.find((u) => u.code.toLowerCase() === aliasCode)) ??
    units.find((u) => u.code.toLowerCase().replace(/[^a-z0-9]+/g, "") === norm);
  return match ? { status: "resolved", unit: match, raw } : { status: "unknown", unit: null, raw };
}
