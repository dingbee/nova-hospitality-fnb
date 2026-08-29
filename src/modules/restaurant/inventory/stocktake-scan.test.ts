import { describe, expect, it } from "vitest";
import {
  filterStocktakeLines,
  matchStocktakeLineByCode,
  type StocktakeScanLine,
} from "./stocktake-scan";

const LINES: StocktakeScanLine[] = [
  {
    id: "line-1",
    item_name: "Coca-Cola 500ml",
    item_sku: "SKU-COKE",
    item_barcode: "5449000000996",
  },
  { id: "line-2", item_name: "Chicken Breast", item_sku: "SKU-CHICKEN", item_barcode: null },
  {
    id: "line-3",
    item_name: "Heineken 330ml",
    item_sku: "SKU-HEINEKEN",
    item_barcode: "8712000030040",
  },
];

describe("matchStocktakeLineByCode", () => {
  it("1. a scanned barcode identifies the correct stocktake line", () => {
    const r = matchStocktakeLineByCode(LINES, "5449000000996");
    expect(r.line?.id).toBe("line-1");
  });

  it("2. a scanned SKU identifies the correct line where the item has no barcode", () => {
    const r = matchStocktakeLineByCode(LINES, "SKU-CHICKEN");
    expect(r.line?.id).toBe("line-2");
  });

  it("3. an unknown code returns a useful, actionable message rather than throwing or silently doing nothing", () => {
    const r = matchStocktakeLineByCode(LINES, "0000000000000");
    expect(r.line).toBeNull();
    expect(r.message).toMatch(/no item on this stocktake matches/i);
    expect(r.message).toMatch(/count it by hand/i);
  });

  it("4. scanning the same code twice resolves to the same single line both times — never duplicates it", () => {
    const first = matchStocktakeLineByCode(LINES, "5449000000996");
    const second = matchStocktakeLineByCode(LINES, "5449000000996");
    expect(first.line?.id).toBe("line-1");
    expect(second.line?.id).toBe("line-1");
    // The underlying line set itself is never touched by a scan.
    expect(LINES).toHaveLength(3);
  });

  it("5. the scanner can only select an existing line — it has no way to add or remove one (pure read, no mutation)", () => {
    const before = [...LINES];
    matchStocktakeLineByCode(LINES, "5449000000996");
    matchStocktakeLineByCode(LINES, "does-not-exist");
    expect(LINES).toEqual(before);
    expect(LINES).toHaveLength(3);
  });

  it("6. tenant isolation: the matcher only ever searches the lines it was given — a code belonging to another tenant's item, never part of this stocktake's own (already tenant-scoped) line set, cannot resolve to anything", () => {
    // getStocktakeFn already scopes `lines` to this tenant's own stocktake
    // before this function ever sees them — this proves the matcher itself
    // adds no back door around that: it has no notion of "search everywhere,"
    // only "search what I was handed."
    const otherTenantsBarcode = "OTHER-TENANT-ITEM-BARCODE";
    const r = matchStocktakeLineByCode(LINES, otherTenantsBarcode);
    expect(r.line).toBeNull();
  });
});

describe("filterStocktakeLines — manual search fallback", () => {
  it("7. manual search finds an item by partial name, independent of any camera capability", () => {
    expect(filterStocktakeLines(LINES, "chicken").map((l) => l.id)).toEqual(["line-2"]);
    expect(filterStocktakeLines(LINES, "cola").map((l) => l.id)).toEqual(["line-1"]);
  });

  it("also matches by SKU and barcode substrings", () => {
    expect(filterStocktakeLines(LINES, "SKU-HEINEKEN").map((l) => l.id)).toEqual(["line-3"]);
    expect(filterStocktakeLines(LINES, "871200003").map((l) => l.id)).toEqual(["line-3"]);
  });

  it("an empty query returns every line unfiltered", () => {
    expect(filterStocktakeLines(LINES, "")).toEqual(LINES);
    expect(filterStocktakeLines(LINES, "   ")).toEqual(LINES);
  });

  it("a query matching nothing returns an empty list rather than throwing", () => {
    expect(filterStocktakeLines(LINES, "nonexistent-item-xyz")).toEqual([]);
  });
});
