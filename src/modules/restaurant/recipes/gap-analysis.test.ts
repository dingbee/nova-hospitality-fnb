import { describe, expect, it } from "vitest";
import {
  catalogPrefix,
  classifyLine,
  costingState,
  measureFromText,
  nextSku,
  suggestStockUnit,
  suggestUnitForMissingItem,
} from "./gap-analysis";

const mapped = (over: Partial<{ hasStockUnit: boolean; stockUnitDimension: string | null; hasCostBasis: boolean }> = {}) => ({
  hasStockUnit: true,
  stockUnitDimension: "mass",
  hasCostBasis: true,
  ...over,
});

describe("classifyLine", () => {
  it("verifies a resolved, unit-compatible, costed line", () => {
    const r = classifyLine({
      mappingStatus: "resolved",
      mapped: mapped(),
      lineUnitDimension: "mass",
      lineUnitStated: true,
      candidateScores: [],
    });
    expect(r.classification).toBe("VERIFIED_MATCH");
    expect(r.costable).toBe(true);
  });

  it("refuses to call a costless verified line costable", () => {
    const r = classifyLine({
      mappingStatus: "resolved",
      mapped: mapped({ hasCostBasis: false }),
      lineUnitDimension: "mass",
      lineUnitStated: true,
      candidateScores: [],
    });
    expect(r.classification).toBe("VERIFIED_MATCH");
    expect(r.costable).toBe(false);
  });

  it("names a missing stock unit before anything else", () => {
    const r = classifyLine({
      mappingStatus: "resolved",
      mapped: mapped({ hasStockUnit: false, stockUnitDimension: null }),
      lineUnitDimension: "mass",
      lineUnitStated: true,
      candidateScores: [],
    });
    expect(r.classification).toBe("MISSING_STOCK_UNIT");
  });

  it("flags a dimension clash as a unit mismatch", () => {
    const r = classifyLine({
      mappingStatus: "resolved",
      mapped: mapped({ stockUnitDimension: "volume" }),
      lineUnitDimension: "mass",
      lineUnitStated: true,
      candidateScores: [],
    });
    expect(r.classification).toBe("UNIT_MISMATCH");
  });

  it("reports an unmapped ingredient with no plausible candidate as missing from the catalog", () => {
    const r = classifyLine({
      mappingStatus: "unresolved",
      mapped: null,
      lineUnitDimension: "mass",
      lineUnitStated: true,
      candidateScores: [0.12],
    });
    expect(r.classification).toBe("MISSING_CATALOG_ITEM");
  });

  it("distinguishes a clear leader from a tie", () => {
    expect(
      classifyLine({
        mappingStatus: "unresolved",
        mapped: null,
        lineUnitDimension: "mass",
        lineUnitStated: true,
        candidateScores: [0.9, 0.4],
      }).classification,
    ).toBe("MATCH_REQUIRES_REVIEW");
    expect(
      classifyLine({
        mappingStatus: "unresolved",
        mapped: null,
        lineUnitDimension: "mass",
        lineUnitStated: true,
        candidateScores: [0.9, 0.85],
      }).classification,
    ).toBe("AMBIGUOUS");
  });
});

describe("costingState", () => {
  it("is COSTABLE only when every line is", () => {
    expect(costingState([true, true])).toBe("COSTABLE");
    expect(costingState([true, false])).toBe("PARTIAL");
    expect(costingState([false, false])).toBe("NON_COSTABLE");
    expect(costingState([])).toBe("NON_COSTABLE");
  });
});

describe("suggestStockUnit", () => {
  it("uses the purchase unit when the item is bought by measure", () => {
    const s = suggestStockUnit({ purchaseUnitCode: "kg", packLabel: null, itemName: "Flour", recipeUnitCodes: [] });
    expect(s.code).toBe("kg");
  });

  it("reads a pack label such as 12 x 1L", () => {
    expect(measureFromText("12 x 1L")).toBe("l");
    const s = suggestStockUnit({ purchaseUnitCode: "carton", packLabel: "12 x 1L", itemName: null, recipeUnitCodes: [] });
    expect(s.code).toBe("l");
  });

  it("stays unresolved when nothing reliable exists", () => {
    const s = suggestStockUnit({ purchaseUnitCode: "btl", packLabel: null, itemName: "Dijon Mustard", recipeUnitCodes: [] });
    expect(s.code).toBeNull();
    expect(s.reason).toContain("no reliable conversion");
  });

  it("refuses to choose when recipes disagree about the dimension", () => {
    const s = suggestStockUnit({
      purchaseUnitCode: "btl",
      packLabel: null,
      itemName: null,
      recipeUnitCodes: ["g", "ml"],
    });
    expect(s.code).toBeNull();
  });
});

describe("suggestUnitForMissingItem", () => {
  it("follows consistent recipe usage", () => {
    expect(suggestUnitForMissingItem(["g", "g", "kg"]).stockUnitCode).toBe("g");
  });
  it("proposes a count unit when recipes count the ingredient", () => {
    expect(suggestUnitForMissingItem(["ea"]).stockUnitCode).toBe("ea");
  });
  it("declines when no unit was stated", () => {
    expect(suggestUnitForMissingItem([]).stockUnitCode).toBeNull();
  });
});

describe("SKU allocation", () => {
  const skus = ["MTN-FNB-SAU-0001", "MTN-FNB-SAU-0014", "MTN-HKG-CLN-0005"];
  it("infers the catalog's own prefix", () => {
    expect(catalogPrefix(skus)).toBe("MTN");
    expect(catalogPrefix([], "SKU")).toBe("SKU");
  });
  it("continues the sequence of the right family", () => {
    expect(nextSku(skus, "MTN", "FNB", "SAU")).toBe("MTN-FNB-SAU-0015");
    expect(nextSku(skus, "MTN", "FNB", "PRD")).toBe("MTN-FNB-PRD-0001");
  });
});