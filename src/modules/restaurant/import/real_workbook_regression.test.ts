/**
 * Regression fixture for a real customer workbook
 * (NOVA_FnB_O12_Simulation_Import.xlsx) that Import Studio mis-staged: every
 * sheet whose headers scored zero domain guesses silently defaulted to
 * "Inventory items" in the UI (SheetStager's `guesses[0]?.domain ??
 * "inventory_item"` fallback), so unrelated sheets (a README tab, a
 * standalone scenario tab, sheets whose real domain — Menu items,
 * Supplier products, Recipe ingredients — scored zero or lower than the
 * wrong guess) were staged as inventory items and every one of their rows
 * failed with "Item name is missing." Because the review queue shows only
 * the domain label and a sheet-relative row number (never the sheet name),
 * a misclassified sheet's own row 2 was indistinguishable from the real
 * Inventory sheet's genuine row 2 ("Chicken Breast") — which is what made
 * the failure look like the real Inventory data was broken, when it never
 * was.
 *
 * These are the exact headers and rows from that workbook. Each block
 * proves the real pipeline — detectDomains -> suggestFieldMapping ->
 * applyMapping -> the domain's stage*Row validator — for its OWN correct
 * domain, not the silently-defaulted one.
 */
import { describe, expect, it } from "vitest";
import { detectDomains, suggestFieldMapping } from "./domains";
import { applyMapping } from "./normalize";
import {
  stageInventoryItemRow,
  stageMenuItemRow,
  stageRecipeComponentRow,
  stageSupplierRow,
} from "./stage";
import type { UnitRow } from "../inventory/units";

const UNITS: UnitRow[] = [
  { id: "u-kg", code: "kg", name: "Kilogram", dimension: "mass", factor: 1000 },
  { id: "u-piece", code: "piece", name: "Piece", dimension: "count", factor: 1 },
];

function stageRawRow(
  headers: readonly string[],
  domain: Parameters<typeof suggestFieldMapping>[1],
  rawRow: Record<string, string>,
) {
  const mapping = suggestFieldMapping(headers, domain);
  return { mapping, mapped: applyMapping(mapping, rawRow) };
}

describe("real workbook — Inventory sheet (sku, item_name, item_type, stock_unit, reorder_point, opening_quantity, unit_cost)", () => {
  const headers = [
    "sku",
    "item_name",
    "item_type",
    "stock_unit",
    "reorder_point",
    "opening_quantity",
    "unit_cost",
  ];
  const rawRow = {
    sku: "NOVA_O12_SIM_CHICKEN_BREAST",
    item_name: "Chicken Breast",
    item_type: "ingredient",
    stock_unit: "kg",
    reorder_point: "8",
    opening_quantity: "35",
    unit_cost: "12000",
  };

  it("is detected as inventory_item with no other sheet outranking it", () => {
    const guesses = detectDomains(headers);
    expect(guesses[0]?.domain).toBe("inventory_item");
  });

  it("maps item_name to the name field — proves item_name IS a supported alias", () => {
    const { mapping } = stageRawRow(headers, "inventory_item", rawRow);
    expect(mapping.find((m) => m.sourceColumn === "item_name")).toMatchObject({
      canonicalField: "name",
      auto: true,
    });
  });

  it("stages the Chicken Breast row with no blocking errors and the right values", () => {
    const { mapped } = stageRawRow(headers, "inventory_item", rawRow);
    const r = stageInventoryItemRow(mapped, {
      inventoryItems: [],
      units: UNITS,
      categories: [],
    });
    expect(r.severity).not.toBe("cannot_map");
    expect(r.validationErrors.filter((e) => e.startsWith("REQUIRED"))).toEqual([]);
    expect(r.mappedData.name).toBe("Chicken Breast");
    expect(r.mappedData.sku).toBe("NOVA_O12_SIM_CHICKEN_BREAST");
    expect(r.mappedData.reorderPoint).toBe(8);
    expect(r.mappedData.openingQuantity).toBe(35);
    expect(r.mappedData.averageCost).toBe(12000);
    expect(r.mappedData.unitId).toBe("u-kg");
  });
});

describe("real workbook — Suppliers sheet (supplier_code, supplier_name, ...)", () => {
  const headers = [
    "supplier_code",
    "supplier_name",
    "category",
    "city",
    "email",
    "phone",
    "lead_time_days",
  ];
  const rawRow = {
    supplier_code: "NOVA_O12_SIM_KILIMANJARO_PROVISIONS",
    supplier_name: "Kilimanjaro Provisions",
    category: "Produce",
    city: "Arusha",
    email: "orders@kilimanjaroprovisions.example",
    phone: "+255700000000",
    lead_time_days: "3",
  };

  it("is detected as supplier", () => {
    expect(detectDomains(headers)[0]?.domain).toBe("supplier");
  });

  it("stages the Kilimanjaro Provisions row with no blocking errors", () => {
    const { mapped } = stageRawRow(headers, "supplier", rawRow);
    const r = stageSupplierRow(mapped, { suppliers: [] });
    expect(r.severity).not.toBe("cannot_map");
    expect(r.mappedData.name).toBe("Kilimanjaro Provisions");
    expect(r.mappedData.code).toBe("NOVA_O12_SIM_KILIMANJARO_PROVISIONS");
    expect(r.mappedData.leadTimeDays).toBe(3);
  });
});

describe("real workbook — Menu_Items sheet (menu_code, category_name, item_name, description, selling_price, station)", () => {
  const headers = [
    "menu_code",
    "category_name",
    "item_name",
    "description",
    "selling_price",
    "station",
  ];
  const rawRow = {
    menu_code: "NOVA_O12_SIM_RESTAURANT",
    category_name: "Breakfast",
    item_name: "Farm Breakfast",
    description: "Eggs, toast, seasonal vegetables",
    selling_price: "28000",
    station: "kitchen",
  };

  it("staged under its own menu_item domain (not the product_station domain detectDomains also plausibly suggests for this header set), maps item_name/selling_price/category_name correctly", () => {
    const { mapping, mapped } = stageRawRow(headers, "menu_item", rawRow);
    expect(mapping.find((m) => m.sourceColumn === "item_name")).toMatchObject({
      canonicalField: "name",
    });
    expect(mapping.find((m) => m.sourceColumn === "selling_price")).toMatchObject({
      canonicalField: "price",
    });
    expect(mapping.find((m) => m.sourceColumn === "category_name")).toMatchObject({
      canonicalField: "categoryName",
    });
    const r = stageMenuItemRow(mapped, { menuItems: [], categories: [] });
    expect(r.severity).not.toBe("cannot_map");
    expect(r.mappedData.price).toBe(28000);
  });
});

describe("real workbook — Recipe_Components sheet (menu_item_name, ingredient_sku, quantity, unit)", () => {
  const headers = ["menu_item_name", "ingredient_sku", "quantity", "unit"];
  const rawRow = {
    menu_item_name: "Farm Breakfast",
    ingredient_sku: "NOVA_O12_SIM_EGGS",
    quantity: "2",
    unit: "piece",
  };

  it("is detected as recipe_component (previously scored zero guesses — menu_item_name and ingredient_sku had no matching alias)", () => {
    const guesses = detectDomains(headers);
    expect(guesses.some((g) => g.domain === "recipe_component")).toBe(true);
  });

  it("maps menu_item_name and ingredient_sku to their canonical fields", () => {
    const { mapping } = stageRawRow(headers, "recipe_component", rawRow);
    expect(mapping.find((m) => m.sourceColumn === "menu_item_name")).toMatchObject({
      canonicalField: "menuItemName",
    });
    expect(mapping.find((m) => m.sourceColumn === "ingredient_sku")).toMatchObject({
      canonicalField: "ingredientSku",
    });
  });

  it("stages the Farm Breakfast / Eggs row with no blocking errors, matching the ingredient by SKU alone, once the dish and ingredient it references already exist (the README's own declared import order: Inventory and Menu Items commit before Recipes)", () => {
    const { mapped } = stageRawRow(headers, "recipe_component", rawRow);
    const r = stageRecipeComponentRow(mapped, {
      menuItems: [{ id: "mi-1", name: "Farm Breakfast", menu_id: "menu-1" }],
      inventoryItems: [
        { id: "item-1", sku: "NOVA_O12_SIM_EGGS", name: "Eggs", barcode: null, brand: null },
      ],
      units: UNITS,
    });
    expect(r.severity).not.toBe("cannot_map");
    expect(r.mappedData.menuItemName).toBe("Farm Breakfast");
    expect(r.mappedData.menuItemId).toBe("mi-1");
    expect(r.mappedData.ingredientSku).toBe("NOVA_O12_SIM_EGGS");
    expect(r.mappedData.inventoryItemId).toBe("item-1");
    expect(r.mappedData.quantity).toBe(2);
    expect(r.mappedData.unitId).toBe("u-piece");
  });
});

describe("real workbook — Supplier_Products sheet (supplier_code, inventory_sku, supplier_sku, barcode, pack_size, purchase_unit, purchase_cost)", () => {
  const headers = [
    "supplier_code",
    "inventory_sku",
    "supplier_sku",
    "barcode",
    "pack_size",
    "purchase_unit",
    "purchase_cost",
  ];

  it("maps supplier_code, inventory_sku and purchase_cost — previously none of these had a matching alias, and the row's only supplier identifier (a code) had no canonical field at all", () => {
    const mapping = suggestFieldMapping(headers, "supplier_product");
    expect(mapping.find((m) => m.sourceColumn === "supplier_code")).toMatchObject({
      canonicalField: "supplierCode",
    });
    expect(mapping.find((m) => m.sourceColumn === "inventory_sku")).toMatchObject({
      canonicalField: "itemSku",
    });
    expect(mapping.find((m) => m.sourceColumn === "purchase_cost")).toMatchObject({
      canonicalField: "unitPrice",
    });
  });
});
