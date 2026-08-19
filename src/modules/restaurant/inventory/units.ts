/**
 * Unit integrity — deterministic, auditable conversion.
 *
 * There are three unit roles in a hospitality inventory:
 *   Purchase unit  (carton)  → Stock unit (bottle) → Consumption unit (ml)
 *
 * Purchase → Stock is a *pack size* on the item (1 carton = 24 bottles).
 * Stock → Consumption is a *dimensional* conversion driven by the units table
 * (every unit carries a factor to the base unit of its dimension).
 *
 * Conversion lives here and only here: no module may invent its own maths.
 */

export interface UnitRow {
  id: string;
  code: string;
  name: string;
  dimension: string;
  factor: number | string;
  base_unit_id?: string | null;
}

export interface ConversionStep {
  label: string;
  from: string;
  to: string;
  factor: number;
}

export interface ConversionResult {
  quantity: number;
  steps: ConversionStep[];
  exact: boolean;
  reason?: string;
}

function factorOf(unit: UnitRow | undefined): number {
  const f = Number(unit?.factor ?? 1);
  return Number.isFinite(f) && f > 0 ? f : 1;
}

/**
 * Convert between two units of the same dimension via their base factors.
 * Returns `exact: false` (and an untouched quantity) when the units are not
 * comparable — callers must surface that rather than silently guessing.
 */
export function convertUnits(
  quantity: number,
  from: UnitRow | undefined,
  to: UnitRow | undefined,
): ConversionResult {
  if (!from || !to || from.id === to.id) {
    return { quantity, steps: [], exact: true };
  }
  if (from.dimension !== to.dimension) {
    return {
      quantity,
      steps: [],
      exact: false,
      reason: `Cannot convert ${from.code} (${from.dimension}) to ${to.code} (${to.dimension}).`,
    };
  }
  const ratio = factorOf(from) / factorOf(to);
  return {
    quantity: quantity * ratio,
    steps: [{ label: "dimensional", from: from.code, to: to.code, factor: ratio }],
    exact: true,
  };
}

/** Purchase unit → stock unit. Pack size is item configuration, not a guess. */
export function purchaseToStock(quantity: number, packSize: number | null | undefined): ConversionResult {
  const pack = Number(packSize ?? 1);
  const factor = Number.isFinite(pack) && pack > 0 ? pack : 1;
  return {
    quantity: quantity * factor,
    steps: [{ label: "pack", from: "purchase unit", to: "stock unit", factor }],
    exact: true,
  };
}

/**
 * Full chain used when a recipe consumes in one unit and stock is held in
 * another (e.g. recipe 150 ml, stock in 750 ml bottles → 0.2 bottles).
 */
export function consumptionToStock(
  quantity: number,
  consumptionUnit: UnitRow | undefined,
  stockUnit: UnitRow | undefined,
): ConversionResult {
  return convertUnits(quantity, consumptionUnit, stockUnit);
}

/** Human-readable audit line for a conversion, safe to persist in notes. */
export function describeConversion(result: ConversionResult): string {
  if (result.steps.length === 0) return "no conversion";
  return result.steps.map((s) => `${s.from}→${s.to} ×${s.factor}`).join(", ");
}