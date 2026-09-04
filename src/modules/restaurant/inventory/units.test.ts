import { describe, expect, it } from "vitest";
import { componentToStock, convertUnits, purchaseToStock, type UnitRow } from "./units";

const KG: UnitRow = { id: "u-kg", code: "KG", name: "Kilogram", dimension: "mass", factor: 1000 };
const G: UnitRow = { id: "u-g", code: "G", name: "Gram", dimension: "mass", factor: 1 };
const L: UnitRow = { id: "u-l", code: "L", name: "Litre", dimension: "volume", factor: 1000 };
const ML: UnitRow = { id: "u-ml", code: "ML", name: "Millilitre", dimension: "volume", factor: 1 };
const PC: UnitRow = { id: "u-pc", code: "PC", name: "Piece", dimension: "count", factor: 1 };

describe("componentToStock — the exact defect spec section 3 describes", () => {
  // "1 KG = TZS 14,000. Therefore 1 G = TZS 14. If a recipe consumes 180 G,
  // ingredient cost = TZS 2,520." average_cost is priced per stock unit
  // (KG); a recipe line entered in G must be converted to KG before it is
  // multiplied by that price, or 180 (grams) × 14,000 (TZS/KG) = TZS
  // 2,520,000 — a thousandfold overcharge — is exactly what a caller gets
  // by skipping this step.
  it("converts a gram-denominated recipe line to the item's KG stock unit before costing", () => {
    const unitById = new Map([
      [KG.id, KG],
      [G.id, G],
    ]);
    const result = componentToStock(180, G.id, { unit_id: KG.id }, unitById);
    expect(result.exact).toBe(true);
    expect(result.quantity).toBeCloseTo(0.18, 6); // 180 g = 0.18 kg
    const unitCost = 14000; // TZS per KG
    expect(Number((result.quantity * unitCost).toFixed(2))).toBe(2520);
  });

  it("is a no-op when the component's unit already matches the item's stock unit", () => {
    const unitById = new Map([[KG.id, KG]]);
    const result = componentToStock(3, KG.id, { unit_id: KG.id }, unitById);
    expect(result).toEqual({ quantity: 3, steps: [], exact: true });
  });

  it("is a no-op when the component carries no unit of its own (assumed already in stock units)", () => {
    const unitById = new Map([[KG.id, KG]]);
    const result = componentToStock(3, null, { unit_id: KG.id }, unitById);
    expect(result).toEqual({ quantity: 3, steps: [], exact: true });
  });

  it("converts ML to L the same way for a beverage item", () => {
    const unitById = new Map([
      [L.id, L],
      [ML.id, ML],
    ]);
    const result = componentToStock(30, ML.id, { unit_id: L.id }, unitById);
    expect(result.exact).toBe(true);
    expect(result.quantity).toBeCloseTo(0.03, 6);
  });

  it("flags a genuine dimension mismatch (mass line against a count-stocked item) instead of silently miscosting", () => {
    const unitById = new Map([
      [G.id, G],
      [PC.id, PC],
    ]);
    const result = componentToStock(180, G.id, { unit_id: PC.id }, unitById);
    expect(result.exact).toBe(false);
    expect(result.reason).toMatch(/cannot convert/i);
  });
});

describe("purchaseToStock — unchanged reference behaviour", () => {
  it("multiplies by pack size (1 PACK of 30 -> 30 stock units)", () => {
    expect(purchaseToStock(1, 30).quantity).toBe(30);
  });
});

describe("convertUnits — unchanged reference behaviour", () => {
  it("is exact and identity when the two units are the same", () => {
    expect(convertUnits(5, KG, KG)).toEqual({ quantity: 5, steps: [], exact: true });
  });
});
