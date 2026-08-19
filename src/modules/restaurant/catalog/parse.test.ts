import { describe, expect, it } from "vitest";
import { normaliseRow, resolvePackSize, type CatalogSourceRow } from "./parse";

const row = (over: Partial<CatalogSourceRow>): CatalogSourceRow => ({
  sourceRow: 2,
  sku: "MTN-FNB-BKE-0001",
  name: "Yeast 500g",
  domain: "FNB",
  category: "Bakery & Baking",
  subcategory: "Baking Ingredient",
  purchaseUnit: "Piece",
  packSize: "500g",
  baseUnit: "g",
  dataStatus: "CONFIRMED",
  source: "Legacy master list",
  ...over,
});

describe("resolvePackSize", () => {
  it("resolves a simple pack in the base unit", () => {
    expect(resolvePackSize("25kg", "kg").packSize).toBe(25);
    expect(resolvePackSize("500g", "g").packSize).toBe(500);
  });

  it("resolves multiplied packs into total base units", () => {
    expect(resolvePackSize("36 x 65ml", "ml").packSize).toBe(2340);
    expect(resolvePackSize("12 x 1L", "L").packSize).toBe(12);
  });

  it("never guesses when information is missing or incomparable", () => {
    expect(resolvePackSize(null, "kg").packSize).toBeNull();
    expect(resolvePackSize("300g", null).packSize).toBeNull();
    expect(resolvePackSize("3 inch", "kg").packSize).toBeNull();
    expect(resolvePackSize("500ml", "g").packSize).toBeNull();
  });
});

describe("normaliseRow", () => {
  it("keeps the supplied SKU immutable", () => {
    expect(normaliseRow(row({})).sku).toBe("MTN-FNB-BKE-0001");
  });

  it("downgrades a confirmed row when something cannot be resolved", () => {
    const r = normaliseRow(row({ packSize: null, baseUnit: null, dataStatus: "CONFIRMED" }));
    expect(r.dataStatus).toBe("UNCONFIRMED");
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.packSize).toBeNull();
  });

  it("flags an unknown purchase unit without inventing one", () => {
    const r = normaliseRow(row({ purchaseUnit: "Unknown" }));
    expect(r.purchaseUnitCode).toBeNull();
    expect(r.dataStatus).toBe("UNCONFIRMED");
  });

  it("preserves the non-F&B domain", () => {
    expect(normaliseRow(row({ domain: "HKG", sku: "MTN-HKG-CLN-0001" })).domain).toBe("HKG");
  });
});
