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
export function purchaseToStock(
  quantity: number,
  packSize: number | null | undefined,
): ConversionResult {
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

/**
 * A quantity already in the item's own packaging content unit (e.g. ml for
 * a bottle whose content is declared in ml), converted into stock units via
 * that item's `content_per_stock_unit` — the bridge for a stock unit that is
 * a physical container (a bottle, a can, a sack) rather than itself a
 * dimensional unit convertUnits can reason about. `contentPerStockUnit`
 * must be a positive, already-validated fact (see
 * restaurant_inventory_items.content_per_stock_unit) — this function never
 * guesses one.
 */
export function consumptionToStockViaContent(
  quantity: number,
  fromUnit: UnitRow | undefined,
  contentUnit: UnitRow | undefined,
  contentPerStockUnit: number | null | undefined,
  stockUnit: UnitRow | undefined,
): ConversionResult {
  const content = Number(contentPerStockUnit ?? 0);
  if (!(content > 0) || !contentUnit) {
    return {
      quantity,
      steps: [],
      exact: false,
      reason: "This item's packaging content (e.g. ml per bottle) has not been configured.",
    };
  }
  const toContentUnit = convertUnits(quantity, fromUnit, contentUnit);
  if (!toContentUnit.exact) return toContentUnit;
  return {
    quantity: toContentUnit.quantity / content,
    steps: [
      ...toContentUnit.steps,
      {
        label: "content",
        from: contentUnit.code,
        to: stockUnit?.code ?? "stock unit",
        factor: 1 / content,
      },
    ],
    exact: true,
  };
}

/**
 * The reverse of `consumptionToStockViaContent`: one stock unit (a bottle),
 * expressed in whichever unit the caller wants (ml, a serving unit, …) via
 * the item's own declared content.
 */
export function stockToConsumptionViaContent(
  quantity: number,
  stockUnit: UnitRow | undefined,
  contentPerStockUnit: number | null | undefined,
  contentUnit: UnitRow | undefined,
  toUnit: UnitRow | undefined,
): ConversionResult {
  const content = Number(contentPerStockUnit ?? 0);
  if (!(content > 0) || !contentUnit) {
    return {
      quantity,
      steps: [],
      exact: false,
      reason: "This item's packaging content (e.g. ml per bottle) has not been configured.",
    };
  }
  const contentQty = quantity * content;
  const converted = convertUnits(contentQty, contentUnit, toUnit);
  if (!converted.exact) return converted;
  return {
    quantity: converted.quantity,
    steps: [
      {
        label: "content",
        from: stockUnit?.code ?? "stock unit",
        to: contentUnit.code,
        factor: content,
      },
      ...converted.steps,
    ],
    exact: true,
  };
}

/**
 * Convert a recipe/modifier component's quantity — expressed in whichever
 * unit the line was written in — into the inventory item's own stock unit,
 * the unit `average_cost` is priced per. A component with no unit of its
 * own, or one that already matches the item's stock unit, is a no-op: most
 * lines are entered directly in stock units and never need this.
 *
 * A direct dimensional conversion (component unit -> stock unit) is tried
 * first, exactly as before. When that fails — the ordinary case for a
 * physical-container stock unit like a bottle, which is not itself a
 * volume/mass/count unit convertUnits can reason about — and the item has
 * declared its own packaging content (content_per_stock_unit +
 * content_unit_id), the conversion is retried through that content as the
 * bridge (component unit -> content unit -> stock units). An item with
 * neither a direct match nor a declared content still gets the original
 * `exact: false` + reason: this never guesses a conversion.
 */
export function componentToStock(
  quantity: number,
  componentUnitId: string | null | undefined,
  item: {
    unit_id?: string | null | undefined;
    content_per_stock_unit?: number | null | undefined;
    content_unit_id?: string | null | undefined;
  },
  unitById: Map<string, UnitRow>,
): ConversionResult {
  if (!componentUnitId || !item.unit_id || componentUnitId === item.unit_id) {
    return { quantity, steps: [], exact: true };
  }
  const direct = convertUnits(quantity, unitById.get(componentUnitId), unitById.get(item.unit_id));
  if (direct.exact) return direct;
  if (item.content_unit_id) {
    return consumptionToStockViaContent(
      quantity,
      unitById.get(componentUnitId),
      unitById.get(item.content_unit_id),
      item.content_per_stock_unit,
      unitById.get(item.unit_id),
    );
  }
  return direct;
}
