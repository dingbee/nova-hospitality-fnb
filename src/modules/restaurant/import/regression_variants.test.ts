/**
 * Regression Case #1 variants — Import Intelligence generalization proof.
 *
 * real_workbook_regression.test.ts locks in the exact headers/rows from the
 * one real customer workbook that exposed the original defect (b39fcaf).
 * That is Regression Case #1. This file is the point of the "make it
 * general or kill it" task: the SAME semantic data, deliberately reshaped —
 * different sheet names, different header words, different column order,
 * abbreviations, different SKU/unit conventions — must still resolve to the
 * same canonical domain and fields through the real pipeline
 * (detectDomains -> suggestFieldMapping -> applyMapping -> stage*Row), not
 * because these specific variants were special-cased, but because the
 * classifier and resolver are genuinely header-content-driven.
 *
 * No workbook-specific rule was added to make any of these pass — every
 * one resolves purely through domains.ts's existing alias/signal-word
 * tables and stage.ts's existing matching engine.
 */
import { describe, expect, it } from "vitest";
import { detectDomains, suggestFieldMapping } from "./domains";
import { applyMapping } from "./normalize";
import {
  stageInventoryItemRow,
  stageMenuItemRow,
  stageRecipeComponentRow,
  stageSupplierProductRow,
  stageSupplierRow,
} from "./stage";
import type { UnitRow } from "../inventory/units";

const UNITS: UnitRow[] = [
  { id: "u-kg", code: "kg", name: "Kilogram", dimension: "mass", factor: 1000 },
  { id: "u-piece", code: "piece", name: "Piece", dimension: "count", factor: 1 },
  { id: "u-ea", code: "ea", name: "Each", dimension: "count", factor: 1 },
];

function stageRawRow(
  headers: readonly string[],
  domain: Parameters<typeof suggestFieldMapping>[1],
  rawRow: Record<string, string>,
) {
  const mapping = suggestFieldMapping(headers, domain);
  return { mapping, mapped: applyMapping(mapping, rawRow) };
}

describe("Inventory — same item, a completely different sheet/header vocabulary (the task's own example)", () => {
  // Original real workbook: sku, item_name, item_type, stock_unit, reorder_point, opening_quantity, unit_cost
  it("resolves 'Stock List' / Description, Unit, Balance, Buy Price to the same canonical fields", () => {
    const headers = ["Description", "Unit", "Balance", "Buy Price"];
    const rawRow = {
      Description: "Chicken Breast",
      Unit: "kg",
      Balance: "35",
      "Buy Price": "12000",
    };

    const guesses = detectDomains(headers);
    expect(guesses[0]?.domain).toBe("inventory_item");

    const { mapped } = stageRawRow(headers, "inventory_item", rawRow);
    const r = stageInventoryItemRow(mapped, { inventoryItems: [], units: UNITS, categories: [] });
    expect(r.severity).not.toBe("cannot_map");
    expect(r.mappedData.name).toBe("Chicken Breast");
    expect(r.mappedData.unitId).toBe("u-kg");
    expect(r.mappedData.openingQuantity).toBe(35);
    expect(r.mappedData.averageCost).toBe(12000);
  });

  it("resolves abbreviated, reordered headers — Item Code before Item Name, Min Level instead of Reorder Point", () => {
    const headers = ["Item Code", "Item Name", "Min Level", "Cost"];
    const rawRow = {
      "Item Code": "CHK-1",
      "Item Name": "Chicken Breast",
      "Min Level": "8",
      Cost: "12000",
    };

    const { mapping, mapped } = stageRawRow(headers, "inventory_item", rawRow);
    expect(mapping.find((m) => m.sourceColumn === "Item Code")).toMatchObject({
      canonicalField: "sku",
    });
    expect(mapping.find((m) => m.sourceColumn === "Min Level")).toMatchObject({
      canonicalField: "reorderPoint",
    });
    const r = stageInventoryItemRow(mapped, { inventoryItems: [], units: UNITS, categories: [] });
    expect(r.mappedData.name).toBe("Chicken Breast");
    expect(r.mappedData.sku).toBe("CHK-1");
    expect(r.mappedData.reorderPoint).toBe(8);
  });

  it("matches an existing item by SKU even though the source expresses it as 'Article Number'", () => {
    const headers = ["Article Number", "Description"];
    const rawRow = { "Article Number": "CHK-1", Description: "Chicken Breast (fresh)" };
    const { mapped } = stageRawRow(headers, "inventory_item", rawRow);
    const r = stageInventoryItemRow(mapped, {
      inventoryItems: [
        { id: "item-1", sku: "CHK-1", name: "Chicken Breast", barcode: null, brand: null },
      ],
      units: UNITS,
      categories: [],
    });
    expect(r.matchStatus).toBe("exact_match");
    expect(r.matchedEntityId).toBe("item-1");
  });
});

describe("Suppliers — same entity, a 'Vendors' sheet with different column names", () => {
  it("resolves Vendor Name / Vendor Code / Contact Email to supplier fields", () => {
    const headers = ["Vendor Name", "Vendor Code", "Contact Email", "Lead Time Days"];
    const rawRow = {
      "Vendor Name": "Kilimanjaro Provisions",
      "Vendor Code": "KILI-01",
      "Contact Email": "orders@kilimanjaroprovisions.example",
      "Lead Time Days": "3",
    };
    expect(detectDomains(headers)[0]?.domain).toBe("supplier");
    const { mapped } = stageRawRow(headers, "supplier", rawRow);
    const r = stageSupplierRow(mapped, { suppliers: [] });
    expect(r.mappedData.name).toBe("Kilimanjaro Provisions");
    expect(r.mappedData.code).toBe("KILI-01");
    expect(r.mappedData.leadTimeDays).toBe(3);
  });
});

describe("Menu — same dish, a 'Dishes' sheet with abbreviated headers, no menu code at all", () => {
  it("resolves Dish / Section / Sell Price to menu_item fields", () => {
    const headers = ["Dish", "Section", "Sell Price"];
    const rawRow = { Dish: "Farm Breakfast", Section: "Breakfast", "Sell Price": "28000" };
    expect(detectDomains(headers).some((g) => g.domain === "menu_item")).toBe(true);
    const { mapped } = stageRawRow(headers, "menu_item", rawRow);
    const r = stageMenuItemRow(mapped, { menuItems: [], categories: [] });
    expect(r.severity).not.toBe("cannot_map");
    expect(r.mappedData.name).toBe("Farm Breakfast");
    expect(r.mappedData.price).toBe(28000);
  });
});

describe("Recipe — same relationship, a 'BOM' (bill of materials) sheet referencing ingredients by name instead of SKU", () => {
  it("resolves Dish / Ingredient / Qty / UOM and matches the ingredient by name", () => {
    const headers = ["Dish", "Ingredient", "Qty", "UOM"];
    const rawRow = { Dish: "Farm Breakfast", Ingredient: "Eggs", Qty: "2", UOM: "piece" };
    expect(detectDomains(headers).some((g) => g.domain === "recipe_component")).toBe(true);
    const { mapping, mapped } = stageRawRow(headers, "recipe_component", rawRow);
    expect(mapping.find((m) => m.sourceColumn === "Dish")).toMatchObject({
      canonicalField: "menuItemName",
    });
    expect(mapping.find((m) => m.sourceColumn === "Ingredient")).toMatchObject({
      canonicalField: "ingredientName",
    });
    const r = stageRecipeComponentRow(mapped, {
      menuItems: [{ id: "mi-1", name: "Farm Breakfast", menu_id: "menu-1" }],
      inventoryItems: [{ id: "item-eggs", sku: "EGG-1", name: "Eggs", barcode: null, brand: null }],
      units: UNITS,
    });
    expect(r.severity).not.toBe("cannot_map");
    expect(r.mappedData.menuItemId).toBe("mi-1");
    expect(r.mappedData.inventoryItemId).toBe("item-eggs");
    expect(r.mappedData.quantity).toBe(2);
  });
});

describe("Supplier products — a 'Purchasing' sheet, EAN instead of barcode, Case Size instead of pack_size", () => {
  it("resolves Vendor Code / Item Code / EAN / Case Size / Buy Price", () => {
    const headers = ["Vendor Code", "Item Code", "EAN", "Case Size", "Buy Price"];
    const rawRow = {
      "Vendor Code": "KILI-01",
      "Item Code": "CHK-1",
      EAN: "6009123456789",
      "Case Size": "10",
      "Buy Price": "11500",
    };
    const { mapping, mapped } = stageRawRow(headers, "supplier_product", rawRow);
    expect(mapping.find((m) => m.sourceColumn === "Vendor Code")).toMatchObject({
      canonicalField: "supplierCode",
    });
    expect(mapping.find((m) => m.sourceColumn === "EAN")).toMatchObject({
      canonicalField: "itemBarcode",
    });
    expect(mapping.find((m) => m.sourceColumn === "Case Size")).toMatchObject({
      canonicalField: "packSize",
    });
    const r = stageSupplierProductRow(mapped, {
      suppliers: [{ id: "sup-1", code: "KILI-01", name: "Kilimanjaro Provisions" }],
      inventoryItems: [
        { id: "item-1", sku: "CHK-1", name: "Chicken Breast", barcode: null, brand: null },
      ],
      existingSupplierProducts: [],
    });
    expect(r.severity).not.toBe("cannot_map");
    expect(r.mappedData.supplierId).toBe("sup-1");
    expect(r.mappedData.inventoryItemId).toBe("item-1");
    expect(r.mappedData.unitPrice).toBe(11500);
    expect(r.mappedData.packSize).toBe(10);
  });
});

describe("Sheet names are hints, never requirements — the same data resolves under a nonsense sheet name", () => {
  it("a sheet literally named 'Stuff' with inventory-shaped headers is still recognised as inventory", () => {
    // The exact example from the spec: Product | UOM | Qty | Vendor | Cost.
    const headers = ["Product", "UOM", "Qty", "Vendor", "Cost"];
    const guesses = detectDomains(headers);
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses.some((g) => g.domain === "inventory_item")).toBe(true);
  });

  it("a sheet literally named 'ABC' with recipe-shaped headers is still recognised as a recipe relationship", () => {
    // The exact example from the spec: Dish | Ingredient | Quantity.
    const headers = ["Dish", "Ingredient", "Quantity"];
    const guesses = detectDomains(headers);
    expect(guesses.some((g) => g.domain === "recipe_component")).toBe(true);
  });
});

describe("Live-UAT-found: a sheet with several recognisable optional fields but no single required-field alias hit still registers real evidence", () => {
  // Found running the real pipeline against a live UAT tenant's actual
  // reference data: "Product Description,Measure,On Hand,Buying Price,
  // Article Number" mapped 5/5 columns correctly via suggestFieldMapping,
  // yet detectDomains originally returned zero guesses for the sheet
  // (DOMAIN_SIGNAL_WORDS didn't list any of these words, and none matched
  // the "name" field's aliases at the time). Fixed by adding "Product
  // Description" as a name alias, and by having detectDomains also count
  // genuine multi-field alias coverage (>=2 distinct fields) as evidence in
  // its own right, not only the separately-curated signal-word list.
  it("resolves an inventory sheet whose headers are Product Description/Measure/On Hand/Buying Price/Article Number", () => {
    const headers = ["Product Description", "Measure", "On Hand", "Buying Price", "Article Number"];
    const guesses = detectDomains(headers);
    expect(guesses.some((g) => g.domain === "inventory_item")).toBe(true);

    const rawRow = {
      "Product Description": "Basmati Rice 25kg Bag",
      Measure: "kg",
      "On Hand": "40",
      "Buying Price": "185000",
      "Article Number": "RICE-01",
    };
    const { mapping, mapped } = stageRawRow(headers, "inventory_item", rawRow);
    expect(mapping.find((m) => m.sourceColumn === "Product Description")).toMatchObject({
      canonicalField: "name",
    });
    const r = stageInventoryItemRow(mapped, { inventoryItems: [], units: UNITS, categories: [] });
    expect(r.severity).not.toBe("cannot_map");
    expect(r.mappedData.name).toBe("Basmati Rice 25kg Bag");
    expect(r.mappedData.sku).toBe("RICE-01");
    expect(r.mappedData.openingQuantity).toBe(40);
  });

  it("a single incidental alias hit (one column called 'Notes') is still too weak to register on its own — no regression of the original silent-default bug", () => {
    const guesses = detectDomains(["Notes"]);
    expect(guesses).toEqual([]);
  });
});
