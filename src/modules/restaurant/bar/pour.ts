/**
 * Pour maths — browser-safe, deterministic.
 *
 * A pour is not a new inventory concept: it is a *serving size* expressed in a
 * unit of the same dimension as the stock unit. All conversion goes through the
 * existing unit factor architecture (`inventory/units.ts`); nothing here
 * hard-codes a bottle size or a measure.
 */
import { convertUnits, type UnitRow } from "../inventory/units";

export interface PourConfig {
  /** Magnitude of one standard serving, expressed in `servingUnit`. */
  servingSize: number | null;
  servingUnit: UnitRow | undefined;
  /** Unit the item is *held* in (e.g. a 700 ml bottle). */
  stockUnit: UnitRow | undefined;
}

export interface PourMaths {
  /** Servings contained in one stock unit (e.g. 23.33 pours per 700 ml bottle). */
  poursPerStockUnit: number | null;
  /** Stock quantity consumed by one serving (e.g. 0.042857 bottles). */
  stockPerPour: number | null;
  exact: boolean;
  reason?: string;
}

/** Round to 6 decimals — enough for ml-in-bottle without float drift in the UI. */
export function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

export function pourMaths(config: PourConfig): PourMaths {
  const size = Number(config.servingSize ?? 0);
  if (!size || size <= 0 || !config.servingUnit || !config.stockUnit) {
    return { poursPerStockUnit: null, stockPerPour: null, exact: false, reason: "Pour size not configured." };
  }
  // One stock unit expressed in the serving unit (1 bottle -> 700 ml).
  const converted = convertUnits(1, config.stockUnit, config.servingUnit);
  if (!converted.exact) {
    return { poursPerStockUnit: null, stockPerPour: null, exact: false, reason: converted.reason };
  }
  const pours = converted.quantity / size;
  if (!Number.isFinite(pours) || pours <= 0) {
    return { poursPerStockUnit: null, stockPerPour: null, exact: false, reason: "Pour size larger than the stock unit." };
  }
  return { poursPerStockUnit: round6(pours), stockPerPour: round6(1 / pours), exact: true };
}

/** Servings available from a stock quantity, floored — you cannot sell a part-pour. */
export function poursAvailable(onHand: number, maths: PourMaths): number | null {
  if (maths.poursPerStockUnit == null) return null;
  return Math.floor(Number(onHand ?? 0) * maths.poursPerStockUnit);
}

/** Pour cost from the item's average cost per stock unit. */
export function pourCost(averageCost: number, maths: PourMaths): number | null {
  if (maths.stockPerPour == null) return null;
  return round6(Number(averageCost ?? 0) * maths.stockPerPour);
}

/** Beverage cost % and gross profit for a sold drink. */
export function pourMargin(sellingPrice: number, cost: number) {
  const price = Number(sellingPrice ?? 0);
  const c = Number(cost ?? 0);
  const gp = price - c;
  return {
    grossProfit: round6(gp),
    costPercent: price > 0 ? round6((c / price) * 100) : null,
    marginPercent: price > 0 ? round6((gp / price) * 100) : null,
  };
}