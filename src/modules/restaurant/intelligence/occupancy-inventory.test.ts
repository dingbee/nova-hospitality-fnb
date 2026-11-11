import { describe, expect, it } from "vitest";
import { forecastIngredientRequirements } from "./occupancy-inventory";

describe("LB-04 recipe-driven inventory demand", () => {
  it("identifies an ingredient shortage after occupancy-driven menu demand rises", () => {
    const result = forecastIngredientRequirements(
      [{ menuItemId: "breakfast", expectedUnits: 80 }],
      [{ menuItemId: "breakfast", inventoryItemId: "eggs", quantityPerMenuUnit: 2, unit: "piece", verified: true }],
      [{ inventoryItemId: "eggs", onHand: 100, reserved: 20, onOrder: 10, unit: "piece", reorderLevel: 15, supplierLeadTimeDays: 2 }],
    );
    expect(result[0]?.forecastRequirement).toBe(160);
    expect(result[0]?.availableAfterCommitments).toBe(90);
    expect(result[0]?.deficit).toBe(70);
    expect(result[0]?.reorderQuantity).toBe(85);
  });

  it("withholds calculations when recipe completeness or units are uncertain", () => {
    const result = forecastIngredientRequirements(
      [{ menuItemId: "dish", expectedUnits: 10 }],
      [{ menuItemId: "dish", inventoryItemId: "oil", quantityPerMenuUnit: 0.1, unit: "litre", verified: false }],
      [{ inventoryItemId: "oil", onHand: 5, reserved: 0, onOrder: 0, unit: "litre", reorderLevel: 1, supplierLeadTimeDays: 3 }],
    );
    expect(result[0]?.reliability).toBe("incomplete_recipe");
    expect(result[0]?.deficit).toBeNull();
  });

  it("does not issue stock or procurement mutations", () => {
    const stock = { inventoryItemId: "flour", onHand: 4, reserved: 1, onOrder: 0, unit: "kg", reorderLevel: 2, supplierLeadTimeDays: 4 };
    forecastIngredientRequirements(
      [{ menuItemId: "bread", expectedUnits: 10 }],
      [{ menuItemId: "bread", inventoryItemId: "flour", quantityPerMenuUnit: 0.5, unit: "kg", verified: true }],
      [stock],
    );
    expect(stock.onHand).toBe(4);
    expect(stock.reserved).toBe(1);
  });
});
