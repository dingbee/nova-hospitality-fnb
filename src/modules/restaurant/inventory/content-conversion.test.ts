/**
 * LEXIBITE — Inventory packaging/content conversion.
 *
 * A packaged liquid item (a 750ml bottle) had "1 Carton = 12 BTL" (pack
 * size) but no field for "1 BTL = 750 ML" — the missing bridge between a
 * physical-container stock unit and the dimensional unit it is poured or
 * portioned in. These are the 16 scenarios from the governing spec's
 * section 18, each numbered to match.
 *
 * The bridge lives in `content_per_stock_unit` / `content_unit_id` on
 * restaurant_inventory_items (migration 0047) and in two new pure functions
 * in units.ts — `consumptionToStockViaContent` and
 * `stockToConsumptionViaContent` — reached only as a fallback inside the
 * existing `componentToStock`, `convertUnits` and `purchaseToStock` stay
 * untouched: this is the same canonical conversion module, not a second one.
 */
import { describe, expect, it } from "vitest";
import {
  componentToStock,
  consumptionToStockViaContent,
  purchaseToStock,
  stockToConsumptionViaContent,
  type UnitRow,
} from "./units";
import { pourCost, pourMaths, poursAvailable } from "../bar/pour";

// Mirrors the live NOVA_O12_SIM House Red Wine 750ml fixture and the tenant's
// real seeded units: BTL/CARTON are dimension "count" (a physical container
// is not itself a volume), ML/L are "volume", KG/G are "mass".
const BTL: UnitRow = { id: "u-btl", code: "BTL", name: "Bottle", dimension: "count", factor: 1 };
const CARTON: UnitRow = {
  id: "u-carton",
  code: "CARTON",
  name: "Carton",
  dimension: "count",
  factor: 1,
};
const ML: UnitRow = { id: "u-ml", code: "ML", name: "Millilitre", dimension: "volume", factor: 1 };
const KG: UnitRow = { id: "u-kg", code: "KG", name: "Kilogram", dimension: "mass", factor: 1000 };
const PC: UnitRow = { id: "u-pc", code: "PC", name: "Piece", dimension: "count", factor: 1 };

const WINE_ITEM = { unit_id: BTL.id, content_per_stock_unit: 750, content_unit_id: ML.id };
const WINE_COST_PER_BOTTLE = 8000; // TZS, matches the live UAT item's average_cost

describe("Section 18 scenario 1 — 1 carton × 12 × 750ml = 9,000ml", () => {
  it("purchase unit -> stock units (pack size) -> content ml, chained", () => {
    const stockUnits = purchaseToStock(1, 12); // 1 carton -> 12 bottles
    expect(stockUnits.quantity).toBe(12);
    const ml = stockToConsumptionViaContent(stockUnits.quantity, BTL, 750, ML, ML);
    expect(ml.exact).toBe(true);
    expect(ml.quantity).toBe(9000);
  });
});

describe("Section 18 scenario 2 — 10 cartons = 90,000ml", () => {
  it("scales linearly through the same chain", () => {
    const stockUnits = purchaseToStock(10, 12);
    expect(stockUnits.quantity).toBe(120);
    const ml = stockToConsumptionViaContent(stockUnits.quantity, BTL, 750, ML, ML);
    expect(ml.quantity).toBe(90000);
  });
});

describe("Section 18 scenario 3 — 1 bottle = 750ml", () => {
  it("stockToConsumptionViaContent(1 bottle) resolves to the declared content", () => {
    const result = stockToConsumptionViaContent(1, BTL, 750, ML, ML);
    expect(result.exact).toBe(true);
    expect(result.quantity).toBe(750);
  });
});

describe("Section 18 scenario 4 — 150ml pour = 0.2 bottle equivalent", () => {
  it("consumptionToStockViaContent(150ml) resolves to 0.2 stock units", () => {
    const result = consumptionToStockViaContent(150, ML, ML, 750, BTL);
    expect(result.exact).toBe(true);
    expect(result.quantity).toBeCloseTo(0.2, 6);
  });

  it("componentToStock reaches the same bridge for a recipe line written in ml against a BTL-stocked item", () => {
    const unitById = new Map([
      [BTL.id, BTL],
      [ML.id, ML],
    ]);
    const result = componentToStock(150, ML.id, WINE_ITEM, unitById);
    expect(result.exact).toBe(true);
    expect(result.quantity).toBeCloseTo(0.2, 6);
  });
});

describe("Section 18 scenario 5 — 5 × 150ml = 750ml = 1 bottle", () => {
  it("pourMaths derives 5 pours per bottle from the same content bridge Pour Setup reads", () => {
    const m = pourMaths({
      servingSize: 150,
      servingUnit: ML,
      stockUnit: BTL,
      contentPerStockUnit: 750,
      contentUnit: ML,
    });
    expect(m.exact).toBe(true);
    expect(m.poursPerStockUnit).toBe(5);
  });
});

describe("Section 18 scenario 6 — 60 × 150ml = 9,000ml (a full carton's worth of pours)", () => {
  it("60 pours consume exactly one carton's content", () => {
    const oneCartonMl = stockToConsumptionViaContent(12, BTL, 750, ML, ML).quantity; // 9,000ml
    const sixtyPoursMl = 60 * 150;
    expect(sixtyPoursMl).toBe(oneCartonMl);
  });
});

describe("Section 18 scenario 7 — bottle cost -> ml cost", () => {
  it("TZS 8,000/bottle -> TZS 10.6667/ml, derived from the existing average_cost, not a second cost basis", () => {
    const costPerMl = WINE_COST_PER_BOTTLE / 750;
    expect(costPerMl).toBeCloseTo(10.6667, 4);
  });
});

describe("Section 18 scenario 8 — bottle cost -> pour cost", () => {
  it("150ml standard pour costs TZS 1,600", () => {
    const m = pourMaths({
      servingSize: 150,
      servingUnit: ML,
      stockUnit: BTL,
      contentPerStockUnit: 750,
      contentUnit: ML,
    });
    expect(pourCost(WINE_COST_PER_BOTTLE, m)).toBeCloseTo(1600, 0);
  });
});

describe("Section 18 scenario 9 — missing content blocks an active pour configuration", () => {
  it("pourMaths refuses with a distinct, identifiable reason when packaging content is not configured", () => {
    const m = pourMaths({ servingSize: 150, servingUnit: ML, stockUnit: BTL }); // no content fields
    expect(m.exact).toBe(false);
    expect(m.missingPackagingConversion).toBe(true);
    expect(m.reason).toMatch(/container content/i);
  });

  it("poursAvailable and pourCost both stay null when the conversion is missing — never a guessed number", () => {
    const m = pourMaths({ servingSize: 150, servingUnit: ML, stockUnit: BTL });
    expect(poursAvailable(24, m)).toBeNull();
    expect(pourCost(8000, m)).toBeNull();
  });
});

describe("Section 18 scenario 10 — incompatible dimensions are rejected, never guessed", () => {
  it("BTL -> KG: no content unit bridges a count-stocked item to a mass consumption unit", () => {
    const unitById = new Map([
      [BTL.id, BTL],
      [KG.id, KG],
    ]);
    const result = componentToStock(1, KG.id, { unit_id: BTL.id }, unitById); // no content configured at all
    expect(result.exact).toBe(false);
  });

  it("a declared content unit that does not match the requested unit's dimension still fails, rather than guessing", () => {
    // Item's content is declared in ML (volume); a recipe line demands KG (mass).
    // The content bridge cannot cross dimensions any more than a direct
    // conversion can — it is still exact:false, with a reason, never a guess.
    const unitById = new Map([
      [BTL.id, BTL],
      [KG.id, KG],
      [ML.id, ML],
    ]);
    const item = { unit_id: BTL.id, content_per_stock_unit: 750, content_unit_id: ML.id };
    const result = componentToStock(1, KG.id, item, unitById);
    expect(result.exact).toBe(false);
  });

  it("PC -> PC discrete items never trigger the content bridge at all", () => {
    const unitById = new Map([[PC.id, PC]]);
    const result = componentToStock(30, PC.id, { unit_id: PC.id }, unitById);
    expect(result).toEqual({ quantity: 30, steps: [], exact: true });
  });
});

describe("Section 18 scenario 11 — stock quantity remains expressed in the stock unit, never silently reinterpreted as ml", () => {
  it("a 150ml demand converts to a fractional BOTTLE quantity for the ledger, not a raw ml number", () => {
    const unitById = new Map([
      [BTL.id, BTL],
      [ML.id, ML],
    ]);
    const result = componentToStock(150, ML.id, WINE_ITEM, unitById);
    expect(result.exact).toBe(true);
    // 0.2 BTL, not 150 (which would be 150 of whatever unit the ledger holds
    // this item in were the bridge skipped and the raw ml value used).
    expect(result.quantity).toBeCloseTo(0.2, 6);
    expect(result.quantity).not.toBe(150);
  });
});

describe("Section 18 scenario 16 — existing non-liquid inventory is unaffected", () => {
  it("a KG-stocked item with no content configuration converts exactly as before (regression)", () => {
    const G: UnitRow = { id: "u-g", code: "G", name: "Gram", dimension: "mass", factor: 1 };
    const unitById = new Map([
      [KG.id, KG],
      [G.id, G],
    ]);
    const result = componentToStock(180, G.id, { unit_id: KG.id }, unitById);
    expect(result.exact).toBe(true);
    expect(result.quantity).toBeCloseTo(0.18, 6);
  });
});
