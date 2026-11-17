import { describe, expect, it } from "vitest";
import { confidenceFor, ingredientKey, scoreCandidate, tokens } from "./mapping";

describe("ingredientKey", () => {
  it("is stable across casing, punctuation and spacing", () => {
    expect(ingredientKey("  Beef  Fillet, trimmed ")).toBe("beef fillet trimmed");
    expect(ingredientKey("BEEF FILLET, TRIMMED")).toBe(ingredientKey("beef fillet trimmed"));
  });

  it("treats missing text as empty rather than throwing", () => {
    expect(ingredientKey(null)).toBe("");
  });
});

describe("tokens", () => {
  it("drops unit noise and stopwords", () => {
    expect(tokens("500 g of fresh beef fillet")).toEqual(["500", "beef", "fillet"]);
  });
});

describe("scoreCandidate", () => {
  const item = {
    sku: "MTN-FNB-MEA-0001",
    name: "Beef Fillet",
    subcategory: "Red Meat",
    categoryName: "Butchery",
  };

  it("scores an exact name match as exact", () => {
    const r = scoreCandidate({ ingredientName: "Beef fillet", candidateSku: null, item });
    expect(r.confidence).toBe("exact");
  });

  it("honours the workbook's own candidate SKU", () => {
    const r = scoreCandidate({
      ingredientName: "Fillet steak",
      candidateSku: "MTN-FNB-MEA-0001",
      item,
    });
    expect(r.score).toBeGreaterThanOrEqual(0.95);
    expect(r.evidence.join(" ")).toContain("Source workbook proposed");
  });

  it("never suggests something an administrator rejected", () => {
    const r = scoreCandidate({
      ingredientName: "Beef fillet",
      candidateSku: null,
      item,
      previouslyRejected: true,
    });
    expect(r.score).toBe(0);
  });

  it("caps confidence when the units are incomparable", () => {
    const r = scoreCandidate({
      ingredientName: "Beef fillet",
      candidateSku: null,
      item,
      unitCompatible: false,
    });
    expect(r.score).toBeLessThanOrEqual(0.5);
    expect(r.confidence).not.toBe("exact");
  });

  it("promotes a mapping a human already confirmed for the same text", () => {
    const r = scoreCandidate({
      ingredientName: "Nyama ya ng'ombe",
      candidateSku: null,
      item,
      previouslyConfirmed: true,
    });
    expect(r.confidence).toBe("high");
  });

  it("bands scores into stable confidence labels", () => {
    expect(confidenceFor(1)).toBe("exact");
    expect(confidenceFor(0.8)).toBe("high");
    expect(confidenceFor(0.5)).toBe("medium");
    expect(confidenceFor(0.1)).toBe("low");
  });
});
