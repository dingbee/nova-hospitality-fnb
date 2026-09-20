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

  it("detects a variant sheet from its headers", () => {
    const guesses = detectDomains(["Menu Item", "Variant Name", "Price Is Delta", "Price"]);
    expect(guesses[0]!.domain).toBe("variant");
  });

  it("detects a modifier group sheet from its headers", () => {
    const guesses = detectDomains(["Group Code", "Modifier Group", "Min Select", "Max Select"]);
    expect(guesses[0]!.domain).toBe("modifier_group");
  });

  it("detects a modifier sheet from its headers", () => {
    const guesses = detectDomains(["Modifier", "Price Delta", "Stock Effect"]);
    expect(guesses[0]!.domain).toBe("modifier");
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

describe("Kilimanjaro technical export identities", () => {
  const supported: Array<[string, string]> = [
    ["06_MENU_CATEGORIES", "category"],
    ["07_MENU_ITEMS", "menu_item"],
    ["08_PRODUCTS", "product_station"],
    ["10_INVENTORY_ITEMS", "inventory_item"],
    ["12_RECIPE_LINES", "recipe_component"],
    ["13_SUPPLIERS", "supplier"],
    ["14_SUPPLIER_PRODUCTS", "supplier_product"],
    ["17_OPENING_STOCK", "opening_stock"],
  ];

  it.each(supported)("%s resolves directly to %s", (sheet, domain) => {
    const identity = classifySheetIdentity(sheet);
    expect(identity.kind).toBe("supported");
    expect(identity.domain).toBe(domain);
  });

  it.each(["00_README", "01_BUSINESS", "02_LOCATIONS", "03_SERVICE_PERIODS", "04_STATIONS", "05_TABLES", "09_INVENTORY_CATEGORIES", "11_RECIPES", "15_PRICING", "16_TAX_SERVICE", "18_DEMO_SCENARIOS"])(
    "%s is preserved as unsupported instead of being forced into an import domain",
    (sheet) => {
      expect(classifySheetIdentity(sheet).kind).toBe("unsupported");
    },
  );

  it("recognises the technical menu item export fields", () => {
    const mapping = suggestFieldMapping(
      ["id", "menu_id", "category", "name", "price_tzs", "description", "allergens", "lifecycle_status"],
      "menu_item",
    );
    expect(mapping.find((m) => m.sourceColumn === "menu_id")?.canonicalField).toBe("menuCode");
    expect(mapping.find((m) => m.sourceColumn === "category")?.canonicalField).toBe("categoryName");
    expect(mapping.find((m) => m.sourceColumn === "price_tzs")?.canonicalField).toBe("price");
    expect(mapping.find((m) => m.sourceColumn === "allergens")?.canonicalField).toBe("allergens");
    expect(mapping.find((m) => m.sourceColumn === "lifecycle_status")?.canonicalField).toBe("available");
  });

  it("recognises technical inventory and supplier-product identity fields", () => {
    const inventory = suggestFieldMapping(
      ["id", "sku", "name", "inventory_category", "purchase_unit", "consumption_unit", "opening_quantity", "average_cost_tzs", "beverage", "shelf_life_days", "allow_negative", "track_batches"],
      "inventory_item",
    );
    expect(inventory.find((m) => m.sourceColumn === "inventory_category")?.canonicalField).toBe("categoryName");
    expect(inventory.find((m) => m.sourceColumn === "purchase_unit")?.canonicalField).toBe("unitCode");
    expect(inventory.find((m) => m.sourceColumn === "average_cost_tzs")?.canonicalField).toBe("averageCost");
    expect(inventory.find((m) => m.sourceColumn === "opening_quantity")?.canonicalField).toBe("openingQuantity");
    expect(inventory.find((m) => m.sourceColumn === "allow_negative")?.canonicalField).toBe("allowNegative");
    expect(inventory.find((m) => m.sourceColumn === "track_batches")?.canonicalField).toBe("trackBatches");

    const supplierProducts = suggestFieldMapping(
      ["supplier_id", "inventory_item_id", "supplier_sku", "name", "purchase_unit", "pack_size", "unit_price_tzs", "min_order_quantity"],
      "supplier_product",
    );
    expect(supplierProducts.find((m) => m.sourceColumn === "supplier_id")?.canonicalField).toBe("supplierCode");
    expect(supplierProducts.find((m) => m.sourceColumn === "inventory_item_id")?.canonicalField).toBe("itemSku");
    expect(supplierProducts.find((m) => m.sourceColumn === "unit_price_tzs")?.canonicalField).toBe("unitPrice");
  });

  it("recognises technical recipe-line and opening-stock fields", () => {
    const recipe = suggestFieldMapping(
      ["recipe_id", "recipe_name", "line_no", "inventory_item", "quantity", "unit"],
      "recipe_component",
    );
    expect(recipe.find((m) => m.sourceColumn === "recipe_name")?.canonicalField).toBe("menuItemName");
    expect(recipe.find((m) => m.sourceColumn === "inventory_item")?.canonicalField).toBe("ingredientName");

    const opening = suggestFieldMapping(
      ["inventory_item_id", "sku", "item", "opening_quantity", "unit", "unit_cost_tzs"],
      "opening_stock",
    );
    expect(opening.find((m) => m.sourceColumn === "inventory_item_id")?.canonicalField).toBe("itemSku");
    expect(opening.find((m) => m.sourceColumn === "item")?.canonicalField).toBe("itemName");
    expect(opening.find((m) => m.sourceColumn === "opening_quantity")?.canonicalField).toBe("quantity");
    expect(opening.find((m) => m.sourceColumn === "unit_cost_tzs")?.canonicalField).toBe("unitCost");
  });
});
