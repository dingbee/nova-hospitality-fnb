import { describe, expect, it } from "vitest";
import {
  normaliseRecipeLine,
  normaliseRecipe,
  recipeUnitCode,
  unitsComparable,
  type RecipeSourceLine,
} from "./parse";

const line = (over: Partial<RecipeSourceLine>): RecipeSourceLine => ({
  sourceRow: 2,
  recipeId: "REC-LUN-0001",
  recipeName: "Beef Satay",
  ingredientName: "Light soy sauce",
  quantityMin: 15,
  quantityMax: 15,
  unit: "ml",
  candidateSku: "MTN-FNB-SAU-0006",
  mappingStatus: "EXACT_CANDIDATE",
  methodOrNotes: "Marinate the beef.",
  sourceFile: "Legacy_Lunch_Recipe_Book.xlsx",
  sourceSheet: "Light Meals",
  ...over,
});

describe("recipeUnitCode", () => {
  it("maps known measures and refuses prose", () => {
    expect(recipeUnitCode("g")).toBe("g");
    expect(recipeUnitCode("pieces")).toBe("ea");
    expect(recipeUnitCode("to taste")).toBeNull();
    expect(recipeUnitCode("scoops (180 ml)")).toBeNull();
  });
});

describe("normaliseRecipeLine", () => {
  it("keeps a candidate mapping when the workbook supplies one", () => {
    const r = normaliseRecipeLine(line({}));
    expect(r.mappingIntent).toBe("candidate");
    expect(r.candidateSku).toBe("MTN-FNB-SAU-0006");
    expect(r.issues).toHaveLength(0);
  });

  it("treats MATCH_REQUIRED as unmapped without inventing a SKU", () => {
    const r = normaliseRecipeLine(line({ candidateSku: null, mappingStatus: "MATCH_REQUIRED" }));
    expect(r.mappingIntent).toBe("match_required");
    expect(r.candidateSku).toBeNull();
  });

  it("preserves both ends of a supplied range", () => {
    const r = normaliseRecipeLine(line({ quantityMin: 180, quantityMax: 220, unit: "g" }));
    expect(r.quantityMin).toBe(180);
    expect(r.quantityMax).toBe(220);
    expect(r.hasRange).toBe(true);
    expect(r.quantity).toBe(180);
  });

  it("flags a missing quantity instead of assuming one", () => {
    const r = normaliseRecipeLine(line({ quantityMin: null, quantityMax: null, unit: "to taste" }));
    expect(r.quantity).toBe(0);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("flags an unmappable unit", () => {
    expect(normaliseRecipeLine(line({ unit: "slices" })).unitCode).toBeNull();
  });
});

describe("normaliseRecipe", () => {
  it("keeps the source recipe id as the code and defaults to version 1", () => {
    const r = normaliseRecipe({
      sourceRow: 2,
      recipeId: "REC-DIN-0001",
      name: "Beef Medallion",
      servicePeriod: "DINNER",
      sourceSection: "Beef",
      portionBasis: "1 person",
      importStatus: "IMPORTED_REVIEW_REQUIRED",
      sourceFile: "f.xlsx",
      sourceSheet: "Beef",
      preparationMethod: null,
    });
    expect(r.code).toBe("REC-DIN-0001");
    expect(r.version).toBe(1);
    expect(r.instructions).toBeNull();
  });
});

describe("unitsComparable", () => {
  it("only allows conversions inside one dimension", () => {
    expect(unitsComparable({ dimension: "mass" }, { dimension: "mass" })).toBe(true);
    expect(unitsComparable({ dimension: "mass" }, { dimension: "volume" })).toBe(false);
    expect(unitsComparable(null, { dimension: "mass" })).toBe(false);
  });
});
