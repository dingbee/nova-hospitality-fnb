/**
 * LB-04 recipe-driven inventory demand and replenishment baseline.
 * Quantities are only compared when their units match exactly. This function
 * never writes stock or issues purchase orders.
 */
export interface MenuDemand {
  menuItemId: string;
  expectedUnits: number;
}
export interface RecipeIngredient {
  menuItemId: string;
  inventoryItemId: string;
  quantityPerMenuUnit: number;
  unit: string;
  verified: boolean;
}
export interface InventoryPosition {
  inventoryItemId: string;
  onHand: number;
  reserved: number;
  onOrder: number;
  unit: string;
  reorderLevel: number;
  supplierLeadTimeDays: number | null;
}
export interface IngredientRequirement {
  inventoryItemId: string;
  unit: string;
  forecastRequirement: number | null;
  availableAfterCommitments: number;
  deficit: number | null;
  reorderQuantity: number | null;
  reliability: "verified_recipe" | "incomplete_recipe" | "missing_position";
  reason: string;
}

const validQty = (n: number) => Number.isFinite(n) && n >= 0;

/**
 * Aggregates forecast menu units through verified recipe lines. If any line
 * for an ingredient is unverified, or a menu item has no recipe lines, that
 * ingredient's requirement is withheld rather than under-counted silently.
 */
export function forecastIngredientRequirements(
  menuDemand: MenuDemand[],
  recipeLines: RecipeIngredient[],
  positions: InventoryPosition[],
): { requirements: IngredientRequirement[]; uncoveredMenuItems: string[] } {
  const demandByMenu = new Map<string, number>();
  for (const row of menuDemand) {
    if (!validQty(row.expectedUnits)) throw new RangeError("expectedUnits must be non-negative");
    demandByMenu.set(row.menuItemId, (demandByMenu.get(row.menuItemId) ?? 0) + row.expectedUnits);
  }

  const linesByMenu = new Map<string, RecipeIngredient[]>();
  for (const line of recipeLines) {
    const lines = linesByMenu.get(line.menuItemId) ?? [];
    lines.push(line);
    linesByMenu.set(line.menuItemId, lines);
  }

  const positionByItem = new Map(positions.map((p) => [p.inventoryItemId, p]));
  const uncoveredMenuItems: string[] = [];
  const required = new Map<string, { qty: number; unit: string; complete: boolean }>();

  for (const [menuItemId, units] of demandByMenu) {
    const lines = linesByMenu.get(menuItemId) ?? [];
    if (lines.length === 0) { uncoveredMenuItems.push(menuItemId); continue; }
    for (const line of lines) {
      const current = required.get(line.inventoryItemId) ?? {
        qty: 0,
        unit: line.unit,
        complete: true,
      };
      if (
        !line.verified ||
        !validQty(line.quantityPerMenuUnit) ||
        current.unit !== line.unit
      ) {
        current.complete = false;
      } else {
        current.qty += units * line.quantityPerMenuUnit;
      }
      required.set(line.inventoryItemId, current);
    }
  }

  const output: IngredientRequirement[] = [];
  for (const [inventoryItemId, req] of required) {
    const position = positionByItem.get(inventoryItemId);
    if (!position) {
      output.push({
        inventoryItemId,
        unit: req.unit,
        forecastRequirement: null,
        availableAfterCommitments: 0,
        deficit: null,
        reorderQuantity: null,
        reliability: "missing_position",
        reason: "No verified inventory position is available.",
      });
      continue;
    }
    if (
      !validQty(position.onHand) ||
      !validQty(position.reserved) ||
      !validQty(position.onOrder) ||
      !validQty(position.reorderLevel)
    ) {
      throw new RangeError("inventory position quantities must be non-negative");
    }
    const available = Math.max(0, position.onHand - position.reserved + position.onOrder);
    if (!req.complete || position.unit !== req.unit) {
      output.push({
        inventoryItemId,
        unit: req.unit,
        forecastRequirement: null,
        availableAfterCommitments: available,
        deficit: null,
        reorderQuantity: null,
        reliability: "incomplete_recipe",
        reason: "Recipe coverage or unit compatibility is incomplete; requirement withheld.",
      });
      continue;
    }
    const deficit = Math.max(0, req.qty - available);
    output.push({
      inventoryItemId,
      unit: req.unit,
      forecastRequirement: Math.round(req.qty * 1000) / 1000,
      availableAfterCommitments: Math.round(available * 1000) / 1000,
      deficit: Math.round(deficit * 1000) / 1000,
      reorderQuantity: Math.max(0, deficit + position.reorderLevel),
      reliability: "verified_recipe",
      reason:
        deficit > 0
          ? "Forecast ingredient demand exceeds stock after reservations and open purchase orders."
          : "Available stock covers forecast ingredient demand.",
    });
  }
  return { requirements: output, uncoveredMenuItems };
}
