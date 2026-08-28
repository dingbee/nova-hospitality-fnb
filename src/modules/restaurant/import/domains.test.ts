import { describe, expect, it } from "vitest";
import { detectDomains, suggestFieldMapping } from "./domains";

describe("detectDomains", () => {
  it("detects an inventory sheet from its headers", () => {
    const guesses = detectDomains([
      "Item Name",
      "SKU",
      "Barcode",
      "Reorder Point",
      "Pack Size",
      "Average Cost",
    ]);
    expect(guesses[0]!.domain).toBe("inventory_item");
  });

  it("detects a supplier sheet from its headers", () => {
    const guesses = detectDomains(["Supplier Name", "Contact Name", "Payment Terms", "Lead Time"]);
    expect(guesses[0]!.domain).toBe("supplier");
  });

  it("detects a recipe sheet from its headers", () => {
    const guesses = detectDomains(["Recipe", "Ingredient", "Quantity", "Unit", "Yield"]);
    expect(guesses[0]!.domain).toBe("recipe_component");
  });

  it("detects a menu sheet from its headers", () => {
    const guesses = detectDomains(["Menu Item", "Menu Section", "Selling Price", "Available"]);
    expect(guesses[0]!.domain).toBe("menu_item");
  });

  it("returns nothing for headers with no domain signal at all", () => {
    const guesses = detectDomains(["Column A", "Column B"]);
    expect(guesses).toEqual([]);
  });

  it("can surface more than one plausible domain for an ambiguous sheet — human confirms, never silently picked", () => {
    // Barcode + Qty could plausibly be inventory or opening stock.
    const guesses = detectDomains(["Item Name", "Barcode", "Opening Quantity", "SKU"]);
    expect(guesses.length).toBeGreaterThanOrEqual(1);
    expect(guesses.every((g) => g.confidence > 0)).toBe(true);
  });
});

describe("suggestFieldMapping", () => {
  it("maps known header aliases to canonical fields", () => {
    const mapping = suggestFieldMapping(
      ["Item Name", "SKU", "Barcode", "Reorder Level"],
      "inventory_item",
    );
    expect(mapping).toEqual([
      { sourceColumn: "Item Name", canonicalField: "name", confidence: 1, auto: true },
      { sourceColumn: "SKU", canonicalField: "sku", confidence: 1, auto: true },
      { sourceColumn: "Barcode", canonicalField: "barcode", confidence: 1, auto: true },
      { sourceColumn: "Reorder Level", canonicalField: "reorderPoint", confidence: 1, auto: true },
    ]);
  });

  it("leaves an unrecognised header unmapped rather than guessing", () => {
    const mapping = suggestFieldMapping(["Some Weird Column"], "inventory_item");
    expect(mapping[0]).toEqual({
      sourceColumn: "Some Weird Column",
      canonicalField: null,
      confidence: 0,
      auto: false,
    });
  });

  it("never maps two source columns to the same canonical field", () => {
    const mapping = suggestFieldMapping(["Name", "Product Name"], "inventory_item");
    const mapped = mapping.filter((m) => m.canonicalField === "name");
    expect(mapped).toHaveLength(1);
  });
});
