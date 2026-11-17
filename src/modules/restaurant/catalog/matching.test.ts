/**
 * O6 — reusable catalog matching engine.
 *
 * Same shape of problem the O6 spec itself describes: an incoming name
 * typed or scanned off a delivery note should surface a likely existing
 * catalog item as a candidate rather than the caller creating a duplicate,
 * and a scanned barcode or typed SKU should win outright over any fuzzy
 * name guess.
 */
import { describe, expect, it } from "vitest";
import { matchCatalogItem, scoreCatalogMatch, type CatalogMatchCandidate } from "./matching";

const COKE: CatalogMatchCandidate = {
  id: "item-1",
  sku: "ITM-2026-00001",
  name: "Coca-Cola 500ml Bottle",
  barcode: "5449000000996",
  supplierSkus: ["CCB-500"],
};
const SPRITE: CatalogMatchCandidate = {
  id: "item-2",
  sku: "ITM-2026-00002",
  name: "Sprite 500ml Bottle",
  barcode: "5449000133328",
};

describe("scoreCatalogMatch", () => {
  it("an exact barcode hit wins outright, at maximum confidence", () => {
    const result = scoreCatalogMatch(
      { barcode: "5449000000996", name: "Some unrelated typed text" },
      COKE,
    );
    expect(result.confidence).toBe("exact");
    expect(result.score).toBe(1);
    expect(result.evidence[0]).toMatch(/barcode/i);
  });

  it("an exact SKU hit wins outright", () => {
    const result = scoreCatalogMatch({ sku: "ITM-2026-00001" }, COKE);
    expect(result.confidence).toBe("exact");
    expect(result.score).toBe(1);
  });

  it("a known supplier code is treated as a near-exact match", () => {
    const result = scoreCatalogMatch({ supplierSku: "CCB-500" }, COKE);
    expect(result.confidence).toBe("exact");
    expect(result.score).toBeGreaterThanOrEqual(0.95);
  });

  it("falls back to fuzzy name matching on partial token overlap, rather than creating a duplicate", () => {
    // "cola" overlaps the candidate name; packaging words like "drink" and
    // "bottle" are stripped as noise by the same stopword list
    // recipes/mapping.ts already uses, reused unchanged rather than
    // reimplemented here.
    const result = scoreCatalogMatch({ name: "Cola drink" }, COKE);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
    expect(result.confidence).not.toBe("exact");
    expect(result.evidence[0]).toMatch(/cola/i);
  });

  it("an exact normalized name match is scored 'exact' without needing an identifier", () => {
    const result = scoreCatalogMatch({ name: "coca cola 500ml bottle" }, COKE);
    expect(result.score).toBe(1);
    expect(result.confidence).toBe("exact");
  });

  it("requires human confirmation for anything short of an identifier or exact name — never silently resolves", () => {
    const result = scoreCatalogMatch({ name: "Fizzy drink" }, COKE);
    expect(["low", "medium"]).toContain(result.confidence);
  });
});

describe("matchCatalogItem", () => {
  it("ranks candidates best-first and never confuses two different items sharing no signal", () => {
    const ranked = matchCatalogItem({ barcode: "5449000133328" }, [COKE, SPRITE]);
    expect(ranked[0]!.candidate.id).toBe("item-2"); // Sprite's barcode, not Coke's
    expect(ranked[0]!.confidence).toBe("exact");
  });

  it("returns nothing above the floor when there is no meaningful signal at all", () => {
    const ranked = matchCatalogItem({ name: "" }, [COKE, SPRITE]);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });

  it("respects a caller-supplied limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...COKE,
      id: `item-${i}`,
      barcode: null,
    }));
    const ranked = matchCatalogItem({ name: "Coca-Cola 500ml Bottle" }, many, { limit: 3 });
    expect(ranked).toHaveLength(3);
  });
});
