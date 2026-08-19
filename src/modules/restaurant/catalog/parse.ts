/**
 * Master catalog source parsing — pure, deterministic, and never inventive.
 *
 * The workbook supplies a human pack label ("36 x 65ml", "25kg") alongside a
 * normalised base unit. This module resolves the label into a numeric pack
 * size expressed in the base unit *only* when the maths is unambiguous.
 * Anything ambiguous stays unresolved and is surfaced for human review — the
 * importer must never guess a conversion, a unit or a price.
 */

export interface CatalogSourceRow {
  sourceRow: number;
  sku: string;
  name: string;
  domain: string;
  category: string | null;
  subcategory: string | null;
  purchaseUnit: string | null;
  packSize: string | null;
  baseUnit: string | null;
  dataStatus: string;
  source: string;
}

export const CATALOG_DOMAINS = ["FNB", "HKG", "OPS", "MNT", "MED", "GEN"] as const;
export type CatalogDomain = (typeof CATALOG_DOMAINS)[number];

export const CATALOG_DOMAIN_LABELS: Record<string, string> = {
  FNB: "Food & Beverage",
  HKG: "Housekeeping",
  OPS: "Operations",
  MNT: "Maintenance",
  MED: "First Aid",
  GEN: "General",
};

/** Base (stock/consumption) unit label → unit code in `restaurant_inventory_units`. */
const BASE_UNIT_CODES: Record<string, string> = {
  kg: "kg",
  g: "g",
  l: "l",
  ml: "ml",
  pc: "ea",
  piece: "ea",
};

/** Purchase unit label → unit code. Count units are created on demand. */
const PURCHASE_UNIT_CODES: Record<string, string> = {
  bottle: "btl",
  carton: "carton",
  packet: "packet",
  piece: "ea",
  kilogram: "kg",
  tin: "tin",
  block: "block",
  gallon: "gallon",
  box: "box",
  bag: "bag",
  litre: "l",
  jar: "jar",
  bucket: "bucket",
  case: "case",
  pack: "pack",
};

/** Count-dimension units that may need creating for a tenant, code → name. */
export const COUNT_UNIT_NAMES: Record<string, string> = {
  carton: "Carton",
  packet: "Packet",
  tin: "Tin",
  block: "Block",
  gallon: "Gallon",
  box: "Box",
  bag: "Bag",
  jar: "Jar",
  bucket: "Bucket",
};

export function baseUnitCode(label: string | null | undefined): string | null {
  if (!label) return null;
  return BASE_UNIT_CODES[label.trim().toLowerCase()] ?? null;
}

export function purchaseUnitCode(label: string | null | undefined): string | null {
  if (!label) return null;
  const key = label.trim().toLowerCase();
  if (key === "unknown") return null;
  return PURCHASE_UNIT_CODES[key] ?? null;
}

const MASS: Record<string, number> = { kg: 1000, g: 1 };
const VOLUME: Record<string, number> = { l: 1000, ml: 1 };
const COUNT: Record<string, number> = { pc: 1, pcs: 1, piece: 1 };

function unitScale(code: string): { dimension: string; factor: number } | null {
  const c = code.toLowerCase();
  if (c in MASS) return { dimension: "mass", factor: MASS[c] };
  if (c in VOLUME) return { dimension: "volume", factor: VOLUME[c] };
  if (c in COUNT) return { dimension: "count", factor: COUNT[c] };
  return null;
}

export interface PackResolution {
  /** Pack size expressed in the base unit, or null when unresolved. */
  packSize: number | null;
  /** Human label exactly as supplied. */
  label: string | null;
  reason?: string;
}

/**
 * Resolve "<n> x <qty><unit>" or "<qty><unit>" into a quantity of `baseUnit`.
 * Returns `packSize: null` (with a reason) whenever the source is ambiguous.
 */
export function resolvePackSize(label: string | null, baseUnit: string | null): PackResolution {
  const raw = label?.trim() || null;
  if (!raw) return { packSize: null, label: raw, reason: "Pack size not supplied." };
  if (!baseUnit) return { packSize: null, label: raw, reason: "Base unit not supplied." };

  const base = unitScale(baseUnit);
  if (!base) return { packSize: null, label: raw, reason: `Unrecognised base unit "${baseUnit}".` };

  const m = raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .match(/^(?:([\d.]+)\s*(?:x|×)\s*)?([\d.]+)\s*([a-z]+)$/);
  if (!m) return { packSize: null, label: raw, reason: `Pack size "${raw}" could not be parsed.` };

  const multiplier = m[1] ? Number(m[1]) : 1;
  const quantity = Number(m[2]);
  const unit = unitScale(m[3]);
  if (!unit || !Number.isFinite(multiplier) || !Number.isFinite(quantity)) {
    return { packSize: null, label: raw, reason: `Unrecognised pack unit in "${raw}".` };
  }
  if (unit.dimension !== base.dimension) {
    return { packSize: null, label: raw, reason: `Pack unit "${m[3]}" is not comparable with base unit "${baseUnit}".` };
  }
  const totalInBase = (multiplier * quantity * unit.factor) / base.factor;
  return { packSize: Number(totalInBase.toFixed(6)), label: raw };
}

export interface NormalisedCatalogRow {
  sku: string;
  name: string;
  domain: string;
  category: string | null;
  subcategory: string | null;
  purchaseUnitLabel: string | null;
  purchaseUnitCode: string | null;
  baseUnitLabel: string | null;
  baseUnitCode: string | null;
  packLabel: string | null;
  packSize: number | null;
  dataStatus: "CONFIRMED" | "UNCONFIRMED";
  issues: string[];
  source: string;
  sourceRow: number;
}

/**
 * Normalise a source row. A row is UNCONFIRMED when the workbook says so *or*
 * when anything material could not be resolved without guessing.
 */
export function normaliseRow(row: CatalogSourceRow): NormalisedCatalogRow {
  const issues: string[] = [];
  const base = baseUnitCode(row.baseUnit);
  const purchase = purchaseUnitCode(row.purchaseUnit);
  const pack = resolvePackSize(row.packSize, row.baseUnit);

  if (!row.baseUnit) issues.push("Missing base unit.");
  else if (!base) issues.push(`Unknown base unit "${row.baseUnit}".`);
  if (!row.purchaseUnit || row.purchaseUnit.trim().toLowerCase() === "unknown") issues.push("Unknown purchase unit.");
  else if (!purchase) issues.push(`Unknown purchase unit "${row.purchaseUnit}".`);
  if (pack.reason) issues.push(pack.reason);

  const declared = row.dataStatus?.trim().toUpperCase() === "CONFIRMED" ? "CONFIRMED" : "UNCONFIRMED";
  const status: "CONFIRMED" | "UNCONFIRMED" = declared === "CONFIRMED" && issues.length === 0 ? "CONFIRMED" : "UNCONFIRMED";

  return {
    sku: row.sku.trim(),
    name: row.name.trim(),
    domain: row.domain.trim().toUpperCase(),
    category: row.category?.trim() ?? null,
    subcategory: row.subcategory?.trim() ?? null,
    purchaseUnitLabel: row.purchaseUnit?.trim() ?? null,
    purchaseUnitCode: purchase,
    baseUnitLabel: row.baseUnit?.trim() ?? null,
    baseUnitCode: base,
    packLabel: pack.label,
    packSize: pack.packSize,
    dataStatus: status,
    issues,
    source: row.source,
    sourceRow: row.sourceRow,
  };
}
