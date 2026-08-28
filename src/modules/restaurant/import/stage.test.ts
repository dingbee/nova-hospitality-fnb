import { describe, expect, it } from "vitest";
import {
  stageInventoryItemRow,
  stageMenuItemRow,
  stageOpeningStockRow,
  stageRecipeComponentRow,
  stageSupplierProductRow,
  stageSupplierRow,
} from "./stage";
import type { UnitRow } from "../inventory/units";

const UNITS: UnitRow[] = [
  { id: "u-kg", code: "kg", name: "Kilogram", dimension: "mass", factor: 1000 },
  { id: "u-ml", code: "ml", name: "Millilitre", dimension: "volume", factor: 1 },
];

describe("stageSupplierRow", () => {
  it("flags a brand new supplier as new_entity, auto-approvable once reviewed", () => {
    const r = stageSupplierRow({ name: "Fresh Foods Ltd" }, { suppliers: [] });
    expect(r.matchStatus).toBe("new_entity");
    expect(r.severity).toBe("new_entity");
    expect(r.validationErrors).toEqual([]);
  });

  it("finds an exact match by code and marks it auto_ok", () => {
    const r = stageSupplierRow(
      { name: "Fresh Foods", code: "FF-01" },
      { suppliers: [{ id: "sup-1", code: "FF-01", name: "Fresh Foods Ltd" }] },
    );
    expect(r.matchStatus).toBe("exact_match");
    expect(r.matchedEntityId).toBe("sup-1");
    expect(r.severity).toBe("auto_ok");
  });

  it("requires a name", () => {
    const r = stageSupplierRow({}, { suppliers: [] });
    expect(r.severity).toBe("cannot_map");
    expect(r.validationErrors[0]).toMatch(/REQUIRED.*name/i);
  });
});

describe("stageInventoryItemRow", () => {
  const ref = {
    inventoryItems: [],
    units: UNITS,
    categories: [{ id: "cat-1", name: "Beverages" }],
  };

  it("matches an existing item by barcode", () => {
    const r = stageInventoryItemRow(
      { name: "Coke 500ml", barcode: "5449000000996" },
      {
        ...ref,
        inventoryItems: [
          {
            id: "item-1",
            sku: "ITM-1",
            name: "Coca-Cola 500ml",
            barcode: "5449000000996",
            brand: null,
          },
        ],
      },
    );
    expect(r.matchStatus).toBe("exact_match");
    expect(r.matchedEntityId).toBe("item-1");
  });

  it("resolves a known unit and a known category", () => {
    const r = stageInventoryItemRow(
      { name: "Rice", unitCode: "Kilograms", categoryName: "Beverages" },
      ref,
    );
    expect(r.mappedData.unitId).toBe("u-kg");
    expect(r.mappedData.categoryId).toBe("cat-1");
    expect(r.validationErrors).toEqual([]);
  });

  it("flags an unrecognised unit for confirmation, without blocking the row", () => {
    const r = stageInventoryItemRow({ name: "Rice", unitCode: "sacks" }, ref);
    expect(r.mappedData.unitId).toBeNull();
    expect(r.validationErrors.some((e) => e.includes("sacks"))).toBe(true);
    expect(r.severity).not.toBe("cannot_map");
  });

  it("treats an unparsable cost as a soft warning, not a blocker", () => {
    const r = stageInventoryItemRow({ name: "Rice", averageCost: "n/a" }, ref);
    expect(r.mappedData.averageCost).toBeNull();
    expect(r.severity).toBe("missing_field");
  });

  it("requires a name", () => {
    const r = stageInventoryItemRow({}, ref);
    expect(r.severity).toBe("cannot_map");
  });
});

describe("stageSupplierProductRow", () => {
  const suppliers = [{ id: "sup-1", code: "FF", name: "Fresh Foods" }];
  const items = [{ id: "item-1", sku: "ITM-1", name: "Rice 25kg", barcode: null, brand: null }];

  it("links a supplier product to both an existing supplier and item", () => {
    const r = stageSupplierProductRow(
      { supplierName: "Fresh Foods", itemSku: "ITM-1", unitPrice: "45000" },
      { suppliers, inventoryItems: items, existingSupplierProducts: [] },
    );
    expect(r.mappedData.supplierId).toBe("sup-1");
    expect(r.mappedData.inventoryItemId).toBe("item-1");
    expect(r.matchStatus).toBe("new_entity");
    expect(r.validationErrors).toEqual([]);
  });

  it("blocks when the referenced item does not exist yet — never invents one", () => {
    const r = stageSupplierProductRow(
      { supplierName: "Fresh Foods", itemName: "Unknown Item", unitPrice: "1000" },
      { suppliers, inventoryItems: items, existingSupplierProducts: [] },
    );
    expect(r.matchStatus).toBe("unmatched");
    expect(r.severity).toBe("cannot_map");
    expect(r.validationErrors.some((e) => e.includes("Unknown Item"))).toBe(true);
  });

  it("recognises an existing supplier product by supplier + supplier SKU", () => {
    const r = stageSupplierProductRow(
      {
        supplierName: "Fresh Foods",
        itemSku: "ITM-1",
        supplierSku: "FF-RICE-25",
        unitPrice: "45000",
      },
      {
        suppliers,
        inventoryItems: items,
        existingSupplierProducts: [
          { id: "sp-1", supplier_id: "sup-1", supplier_sku: "FF-RICE-25", barcode: null },
        ],
      },
    );
    expect(r.matchStatus).toBe("exact_match");
    expect(r.matchedEntityId).toBe("sp-1");
  });

  it("requires a unit price", () => {
    const r = stageSupplierProductRow(
      { supplierName: "Fresh Foods", itemSku: "ITM-1" },
      { suppliers, inventoryItems: items, existingSupplierProducts: [] },
    );
    expect(r.validationErrors.some((e) => /unit price/i.test(e))).toBe(true);
  });
});

describe("stageMenuItemRow", () => {
  it("stages a brand new dish", () => {
    const r = stageMenuItemRow(
      { name: "Grilled Chicken", price: "18000" },
      { menuItems: [], categories: [] },
    );
    expect(r.matchStatus).toBe("new_entity");
    expect(r.mappedData.price).toBe(18000);
    expect(r.mappedData.available).toBe(true);
  });

  it("requires a price", () => {
    const r = stageMenuItemRow({ name: "Grilled Chicken" }, { menuItems: [], categories: [] });
    expect(r.severity).toBe("cannot_map");
  });

  it("respects an explicit unavailable flag", () => {
    const r = stageMenuItemRow(
      { name: "Seasonal Soup", price: "9000", available: "No" },
      { menuItems: [], categories: [] },
    );
    expect(r.mappedData.available).toBe(false);
  });
});

describe("stageRecipeComponentRow", () => {
  const menuItems = [{ id: "mi-1", name: "Grilled Chicken", menu_id: "menu-1" }];
  const items = [
    { id: "item-1", sku: "ITM-1", name: "Chicken Breast", barcode: null, brand: null },
  ];

  it("links an ingredient line to an existing dish and ingredient", () => {
    const r = stageRecipeComponentRow(
      { menuItemName: "Grilled Chicken", ingredientSku: "ITM-1", quantity: "0.2", unitCode: "kg" },
      { menuItems, inventoryItems: items, units: UNITS },
    );
    expect(r.mappedData.menuItemId).toBe("mi-1");
    expect(r.mappedData.inventoryItemId).toBe("item-1");
    expect(r.mappedData.unitId).toBe("u-kg");
    expect(r.matchStatus).toBe("exact_match");
  });

  it("blocks when the dish has not been imported/matched yet", () => {
    const r = stageRecipeComponentRow(
      { menuItemName: "Not Yet Imported Dish", ingredientSku: "ITM-1", quantity: "0.2" },
      { menuItems, inventoryItems: items, units: UNITS },
    );
    expect(r.matchStatus).toBe("unmatched");
    expect(r.severity).toBe("cannot_map");
  });

  it("defaults yield to 100% when not supplied", () => {
    const r = stageRecipeComponentRow(
      { menuItemName: "Grilled Chicken", ingredientSku: "ITM-1", quantity: "0.2" },
      { menuItems, inventoryItems: items, units: UNITS },
    );
    expect(r.mappedData.yieldPercent).toBe(100);
  });
});

describe("stageOpeningStockRow", () => {
  const items = [{ id: "item-1", sku: "ITM-1", name: "Rice", barcode: null, brand: null }];
  const locations = [{ id: "loc-1", name: "Dry Store" }];

  it("stages an opening balance for a matched item at a named location", () => {
    const r = stageOpeningStockRow(
      { itemSku: "ITM-1", quantity: "250", unitCode: "kg", locationName: "Dry Store" },
      { inventoryItems: items, units: UNITS, locations },
    );
    expect(r.matchStatus).toBe("exact_match");
    expect(r.mappedData.inventoryItemId).toBe("item-1");
    expect(r.mappedData.locationId).toBe("loc-1");
    expect(r.mappedData.quantity).toBe(250);
  });

  it("blocks opening stock for an item that does not exist yet", () => {
    const r = stageOpeningStockRow(
      { itemName: "Ghost Item", quantity: "10" },
      { inventoryItems: items, units: UNITS, locations },
    );
    expect(r.matchStatus).toBe("unmatched");
    expect(r.severity).toBe("cannot_map");
  });

  it("falls back to the workspace default location when the named one is not found", () => {
    const r = stageOpeningStockRow(
      { itemSku: "ITM-1", quantity: "10", locationName: "Unknown Store" },
      { inventoryItems: items, units: UNITS, locations },
    );
    expect(r.mappedData.locationId).toBeNull();
    expect(r.validationErrors.some((e) => e.includes("Unknown Store"))).toBe(true);
    expect(r.severity).not.toBe("cannot_map");
  });
});
