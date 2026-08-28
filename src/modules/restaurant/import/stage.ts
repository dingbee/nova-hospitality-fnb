/**
 * O7 Import Studio — staging.
 *
 * Pure functions: given one mapped row and the tenant's existing reference
 * data (already fetched by the caller), decide what NoVA thinks this row is
 * — matched to something that exists, clearly new, or something a human has
 * to look at — and why. Nothing here writes anything; see import.server.ts's
 * commit step for the only place a staged record becomes real data.
 */
import { matchCatalogItem, type CatalogMatchResult } from "../catalog/matching";
import type { UnitRow } from "../inventory/units";
import { parseBoolean, parseNumber, resolveUnit } from "./normalize";
import {
  inventoryItemCandidates,
  menuItemCandidates,
  supplierCandidates,
  type InventoryItemRow,
  type MenuItemRow,
  type SupplierRow,
} from "./matching-adapters";

export type MatchStatus =
  "new_entity" | "exact_match" | "possible_match" | "ambiguous" | "unmatched" | "invalid";
export type Severity =
  "cannot_map" | "ambiguous_match" | "missing_field" | "new_entity" | "auto_ok";

export interface StageResult {
  mappedData: Record<string, unknown>;
  matchStatus: MatchStatus;
  matchedEntityId: string | null;
  matchedEntityTable: string | null;
  matchConfidence: number | null;
  matchEvidence: string[];
  validationErrors: string[];
  severity: Severity;
}

const REQUIRED = "REQUIRED:";
function required(message: string) {
  return `${REQUIRED} ${message}`;
}
function isBlocking(errors: readonly string[]) {
  return errors.some((e) => e.startsWith(REQUIRED));
}

export function computeSeverity(
  matchStatus: MatchStatus,
  validationErrors: readonly string[],
): Severity {
  if (matchStatus === "invalid" || matchStatus === "unmatched" || isBlocking(validationErrors))
    return "cannot_map";
  if (matchStatus === "ambiguous" || matchStatus === "possible_match") return "ambiguous_match";
  if (validationErrors.length > 0) return "missing_field";
  if (matchStatus === "new_entity") return "new_entity";
  return "auto_ok";
}

interface Classified {
  status: MatchStatus;
  id: string | null;
  confidence: number | null;
  evidence: string[];
}

/**
 * A near-tie between the top two candidates is genuine ambiguity, not just
 * "not sure yet" — checked even at the "exact" confidence tier, since that
 * tier includes a full-name-token match, not only a literal identifier, and
 * two distinct existing items can each fully contain the same word.
 */
function classify(results: readonly CatalogMatchResult[]): Classified {
  const top = results[0];
  if (!top || top.score === 0)
    return { status: "new_entity", id: null, confidence: null, evidence: [] };
  const runnerUp = results[1];
  const tie = runnerUp && runnerUp.score > 0 && runnerUp.score >= top.score - 0.05;
  if (tie) {
    return {
      status: "ambiguous",
      id: top.candidate.id,
      confidence: top.score,
      evidence: top.evidence,
    };
  }
  if (top.confidence === "exact") {
    return {
      status: "exact_match",
      id: top.candidate.id,
      confidence: top.score,
      evidence: top.evidence,
    };
  }
  return {
    status: "possible_match",
    id: top.candidate.id,
    confidence: top.score,
    evidence: top.evidence,
  };
}

/** For a relationship row (supplier_product / recipe_component / opening_stock): the referenced entity must already exist. */
function classifyExisting(
  results: readonly CatalogMatchResult[],
  label: string,
): Classified & { error?: string } {
  const c = classify(results);
  if (c.status === "new_entity") {
    return {
      ...c,
      status: "unmatched",
      error: `${label} was not found in the existing catalog — import it first, then re-stage this sheet.`,
    };
  }
  return c;
}

function numField(
  raw: string | undefined,
  label: string,
  errors: string[],
  opts: { required?: boolean } = {},
) {
  if (raw === undefined) {
    if (opts.required) errors.push(required(`${label} is missing.`));
    return undefined;
  }
  const n = parseNumber(raw);
  if (n === null) {
    errors.push(
      opts.required
        ? required(`${label} "${raw}" is not a number.`)
        : `${label} "${raw}" is not a number — left blank.`,
    );
    return undefined;
  }
  return n;
}

/* ---------------- Supplier ---------------- */

export function stageSupplierRow(
  mapped: Record<string, string>,
  ref: { suppliers: readonly SupplierRow[] },
): StageResult {
  const errors: string[] = [];
  if (!mapped.name) errors.push(required("Supplier name is missing."));
  const leadTimeDays = numField(mapped.leadTimeDays, "Lead time", errors);

  const results = matchCatalogItem(
    { sku: mapped.code, name: mapped.name },
    supplierCandidates(ref.suppliers),
  );
  const c = classify(results);

  return {
    mappedData: {
      name: mapped.name ?? null,
      code: mapped.code ?? null,
      contactName: mapped.contactName ?? null,
      email: mapped.email ?? null,
      phone: mapped.phone ?? null,
      address: mapped.address ?? null,
      paymentTerms: mapped.paymentTerms ?? null,
      leadTimeDays: leadTimeDays ?? null,
    },
    matchStatus: c.status,
    matchedEntityId: c.id,
    matchedEntityTable: c.id ? "restaurant_suppliers" : null,
    matchConfidence: c.confidence,
    matchEvidence: c.evidence,
    validationErrors: errors,
    severity: computeSeverity(c.status, errors),
  };
}

/* ---------------- Inventory item ---------------- */

export function stageInventoryItemRow(
  mapped: Record<string, string>,
  ref: {
    inventoryItems: readonly InventoryItemRow[];
    units: readonly UnitRow[];
    categories: readonly { id: string; name: string }[];
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.name) errors.push(required("Item name is missing."));

  const reorderPoint = numField(mapped.reorderPoint, "Reorder point", errors);
  const parLevel = numField(mapped.parLevel, "Par level", errors);
  const averageCost = numField(mapped.averageCost, "Unit cost", errors);
  const packSize = numField(mapped.packSize, "Pack size", errors);
  const openingQuantity = numField(mapped.openingQuantity, "Opening quantity", errors);

  let categoryId: string | null = null;
  if (mapped.categoryName) {
    const cat = ref.categories.find(
      (c) => c.name.toLowerCase() === mapped.categoryName!.toLowerCase(),
    );
    if (cat) categoryId = cat.id;
    else errors.push(`Category "${mapped.categoryName}" not found — will be left uncategorised.`);
  }

  const unitRes = resolveUnit(mapped.unitCode, ref.units);
  if (mapped.unitCode && unitRes.status === "unknown") {
    errors.push(`Unit "${mapped.unitCode}" was not recognised — confirm the stock unit manually.`);
  }
  const openingUnitRes = resolveUnit(mapped.openingUnit, ref.units);

  const results = matchCatalogItem(
    { barcode: mapped.barcode, sku: mapped.sku, name: mapped.name },
    inventoryItemCandidates(ref.inventoryItems),
  );
  const c = classify(results);

  return {
    mappedData: {
      name: mapped.name ?? null,
      sku: mapped.sku ?? null,
      barcode: mapped.barcode ?? null,
      brand: mapped.brand ?? null,
      categoryId,
      categoryName: mapped.categoryName ?? null,
      unitId: unitRes.unit?.id ?? null,
      unitCode: mapped.unitCode ?? null,
      packSize: packSize ?? null,
      reorderPoint: reorderPoint ?? null,
      parLevel: parLevel ?? null,
      averageCost: averageCost ?? null,
      openingQuantity: openingQuantity ?? null,
      openingUnitId: openingUnitRes.unit?.id ?? null,
      openingUnit: mapped.openingUnit ?? null,
    },
    matchStatus: c.status,
    matchedEntityId: c.id,
    matchedEntityTable: c.id ? "restaurant_inventory_items" : null,
    matchConfidence: c.confidence,
    matchEvidence: c.evidence,
    validationErrors: errors,
    severity: computeSeverity(c.status, errors),
  };
}

/* ---------------- Supplier product ---------------- */

export function stageSupplierProductRow(
  mapped: Record<string, string>,
  ref: {
    suppliers: readonly SupplierRow[];
    inventoryItems: readonly InventoryItemRow[];
    existingSupplierProducts: readonly {
      id: string;
      supplier_id: string;
      supplier_sku: string | null;
      barcode: string | null;
    }[];
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.supplierName) errors.push(required("Supplier is missing."));
  if (!mapped.itemName && !mapped.itemSku && !mapped.itemBarcode)
    errors.push(required("Item to link is missing (name, SKU or barcode)."));
  const unitPrice = numField(mapped.unitPrice, "Unit price", errors, { required: true });
  const packSize = numField(mapped.packSize, "Pack size", errors);
  const minOrderQuantity = numField(mapped.minOrderQuantity, "Minimum order quantity", errors);
  const leadTimeDays = numField(mapped.leadTimeDays, "Lead time", errors);

  const supplierMatch = classifyExisting(
    matchCatalogItem({ name: mapped.supplierName }, supplierCandidates(ref.suppliers)),
    `Supplier "${mapped.supplierName ?? "?"}"`,
  );
  const itemMatch = classifyExisting(
    matchCatalogItem(
      { barcode: mapped.itemBarcode, sku: mapped.itemSku, name: mapped.itemName },
      inventoryItemCandidates(ref.inventoryItems),
    ),
    `Item "${mapped.itemName ?? mapped.itemSku ?? mapped.itemBarcode ?? "?"}"`,
  );
  if (supplierMatch.error) errors.push(required(supplierMatch.error));
  if (itemMatch.error) errors.push(required(itemMatch.error));

  let overall: Classified = { status: "new_entity", id: null, confidence: null, evidence: [] };
  if (
    supplierMatch.status !== "unmatched" &&
    itemMatch.status !== "unmatched" &&
    supplierMatch.id &&
    itemMatch.id
  ) {
    const existing = ref.existingSupplierProducts.find(
      (sp) =>
        sp.supplier_id === supplierMatch.id &&
        ((mapped.supplierSku && sp.supplier_sku === mapped.supplierSku) ||
          (mapped.itemBarcode && sp.barcode === mapped.itemBarcode)),
    );
    overall = existing
      ? {
          status: "exact_match",
          id: existing.id,
          confidence: 1,
          evidence: ["Existing supplier product on file"],
        }
      : { status: "new_entity", id: null, confidence: null, evidence: [] };
  } else {
    overall = { status: "unmatched", id: null, confidence: null, evidence: [] };
  }

  return {
    mappedData: {
      supplierName: mapped.supplierName ?? null,
      supplierId: supplierMatch.id,
      itemName: mapped.itemName ?? null,
      itemSku: mapped.itemSku ?? null,
      itemBarcode: mapped.itemBarcode ?? null,
      inventoryItemId: itemMatch.id,
      supplierSku: mapped.supplierSku ?? null,
      barcode: mapped.itemBarcode ?? null,
      name: mapped.name ?? mapped.itemName ?? null,
      packSize: packSize ?? null,
      unitPrice: unitPrice ?? null,
      minOrderQuantity: minOrderQuantity ?? null,
      leadTimeDays: leadTimeDays ?? null,
    },
    matchStatus: overall.status,
    matchedEntityId: overall.id,
    matchedEntityTable: overall.id ? "restaurant_supplier_products" : null,
    matchConfidence: overall.confidence,
    matchEvidence: overall.evidence,
    validationErrors: errors,
    severity: computeSeverity(overall.status, errors),
  };
}

/* ---------------- Menu item ---------------- */

export function stageMenuItemRow(
  mapped: Record<string, string>,
  ref: { menuItems: readonly MenuItemRow[]; categories: readonly { id: string; name: string }[] },
): StageResult {
  const errors: string[] = [];
  if (!mapped.name) errors.push(required("Dish/drink name is missing."));
  const price = numField(mapped.price, "Price", errors, { required: true });

  let categoryId: string | null = null;
  if (mapped.categoryName) {
    const cat = ref.categories.find(
      (c) => c.name.toLowerCase() === mapped.categoryName!.toLowerCase(),
    );
    if (cat) categoryId = cat.id;
    else errors.push(`Category "${mapped.categoryName}" not found — will be left uncategorised.`);
  }

  const results = matchCatalogItem({ name: mapped.name }, menuItemCandidates(ref.menuItems));
  const c = classify(results);
  const available = parseBoolean(mapped.available);

  return {
    mappedData: {
      name: mapped.name ?? null,
      categoryId,
      categoryName: mapped.categoryName ?? null,
      description: mapped.description ?? null,
      price: price ?? null,
      available: available ?? true,
    },
    matchStatus: c.status,
    matchedEntityId: c.id,
    matchedEntityTable: c.id ? "restaurant_menu_items" : null,
    matchConfidence: c.confidence,
    matchEvidence: c.evidence,
    validationErrors: errors,
    severity: computeSeverity(c.status, errors),
  };
}

/* ---------------- Recipe component (menu item ingredient) ---------------- */

const STATUS_BADNESS: Record<MatchStatus, number> = {
  unmatched: 5,
  invalid: 5,
  ambiguous: 4,
  possible_match: 3,
  new_entity: 2,
  exact_match: 1,
};
function worse(a: MatchStatus, b: MatchStatus): MatchStatus {
  return STATUS_BADNESS[a] >= STATUS_BADNESS[b] ? a : b;
}

export function stageRecipeComponentRow(
  mapped: Record<string, string>,
  ref: {
    menuItems: readonly MenuItemRow[];
    inventoryItems: readonly InventoryItemRow[];
    units: readonly UnitRow[];
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.menuItemName)
    errors.push(required("Dish/drink to attach this ingredient to is missing."));
  if (!mapped.ingredientName && !mapped.ingredientSku && !mapped.ingredientBarcode) {
    errors.push(required("Ingredient to link is missing (name, SKU or barcode)."));
  }
  const quantity = numField(mapped.quantity, "Quantity", errors, { required: true });
  const yieldPercent = numField(mapped.yieldPercent, "Yield %", errors) ?? 100;

  const unitRes = resolveUnit(mapped.unitCode, ref.units);
  if (mapped.unitCode && unitRes.status === "unknown") {
    errors.push(`Unit "${mapped.unitCode}" was not recognised — confirm it manually.`);
  }

  const menuItemMatch = classifyExisting(
    matchCatalogItem({ name: mapped.menuItemName }, menuItemCandidates(ref.menuItems)),
    `Dish/drink "${mapped.menuItemName ?? "?"}"`,
  );
  const ingredientMatch = classifyExisting(
    matchCatalogItem(
      { barcode: mapped.ingredientBarcode, sku: mapped.ingredientSku, name: mapped.ingredientName },
      inventoryItemCandidates(ref.inventoryItems),
    ),
    `Ingredient "${mapped.ingredientName ?? mapped.ingredientSku ?? mapped.ingredientBarcode ?? "?"}"`,
  );
  if (menuItemMatch.error) errors.push(required(menuItemMatch.error));
  if (ingredientMatch.error) errors.push(required(ingredientMatch.error));

  const overallStatus = worse(menuItemMatch.status, ingredientMatch.status);

  return {
    mappedData: {
      menuItemName: mapped.menuItemName ?? null,
      menuItemId: menuItemMatch.id,
      ingredientName: mapped.ingredientName ?? null,
      ingredientSku: mapped.ingredientSku ?? null,
      ingredientBarcode: mapped.ingredientBarcode ?? null,
      inventoryItemId: ingredientMatch.id,
      quantity: quantity ?? null,
      unitId: unitRes.unit?.id ?? null,
      unitCode: mapped.unitCode ?? null,
      yieldPercent,
      notes: mapped.notes ?? null,
    },
    matchStatus: overallStatus,
    matchedEntityId: null,
    matchedEntityTable: null,
    matchConfidence: Math.min(menuItemMatch.confidence ?? 1, ingredientMatch.confidence ?? 1),
    matchEvidence: [...menuItemMatch.evidence, ...ingredientMatch.evidence],
    validationErrors: errors,
    severity: computeSeverity(overallStatus, errors),
  };
}

/* ---------------- Opening stock ---------------- */

export function stageOpeningStockRow(
  mapped: Record<string, string>,
  ref: {
    inventoryItems: readonly InventoryItemRow[];
    units: readonly UnitRow[];
    locations: readonly { id: string; name: string }[];
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.itemName && !mapped.itemSku && !mapped.itemBarcode)
    errors.push(required("Item to stock is missing (name, SKU or barcode)."));
  const quantity = numField(mapped.quantity, "Opening quantity", errors, { required: true });
  const unitCost = numField(mapped.unitCost, "Unit cost", errors);

  let locationId: string | null = null;
  if (mapped.locationName) {
    const loc = ref.locations.find(
      (l) => l.name.toLowerCase() === mapped.locationName!.toLowerCase(),
    );
    if (loc) locationId = loc.id;
    else
      errors.push(
        `Location "${mapped.locationName}" not found — will use the workspace's default location.`,
      );
  }

  const unitRes = resolveUnit(mapped.unitCode, ref.units);
  if (mapped.unitCode && unitRes.status === "unknown") {
    errors.push(`Unit "${mapped.unitCode}" was not recognised — confirm it manually.`);
  }

  const itemMatch = classifyExisting(
    matchCatalogItem(
      { barcode: mapped.itemBarcode, sku: mapped.itemSku, name: mapped.itemName },
      inventoryItemCandidates(ref.inventoryItems),
    ),
    `Item "${mapped.itemName ?? mapped.itemSku ?? mapped.itemBarcode ?? "?"}"`,
  );
  if (itemMatch.error) errors.push(required(itemMatch.error));

  return {
    mappedData: {
      itemName: mapped.itemName ?? null,
      itemSku: mapped.itemSku ?? null,
      itemBarcode: mapped.itemBarcode ?? null,
      inventoryItemId: itemMatch.id,
      locationId,
      locationName: mapped.locationName ?? null,
      quantity: quantity ?? null,
      unitId: unitRes.unit?.id ?? null,
      unitCode: mapped.unitCode ?? null,
      unitCost: unitCost ?? null,
    },
    matchStatus: itemMatch.status,
    matchedEntityId: itemMatch.id,
    matchedEntityTable: itemMatch.id ? "restaurant_inventory_items" : null,
    matchConfidence: itemMatch.confidence,
    matchEvidence: itemMatch.evidence,
    validationErrors: errors,
    severity: computeSeverity(itemMatch.status, errors),
  };
}
