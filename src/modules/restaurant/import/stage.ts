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
  modifierGroupCandidates,
  stationCandidates,
  supplierCandidates,
  type InventoryItemRow,
  type MenuItemRow,
  type ModifierGroupRow,
  type ProductRow,
  type StationRow,
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

/* ---------------- Product / station link (the bridge a menu item needs before it can carry a variant or modifier) ---------------- */

export function stageProductStationRow(
  mapped: Record<string, string>,
  ref: {
    menuItems: readonly MenuItemRow[];
    stations: readonly StationRow[];
    existingProducts: readonly ProductRow[];
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.menuItemName)
    errors.push(required("Dish/drink to attach this product to is missing."));
  if (!mapped.stationCode) errors.push(required("Station is missing."));
  const price = numField(mapped.price, "Price", errors);
  if (price !== undefined && price < 0) errors.push(required("Price cannot be negative."));

  const menuItemMatch = classifyExisting(
    matchCatalogItem({ name: mapped.menuItemName }, menuItemCandidates(ref.menuItems)),
    `Dish/drink "${mapped.menuItemName ?? "?"}"`,
  );
  const stationMatch = classifyExisting(
    matchCatalogItem(
      { sku: mapped.stationCode, name: mapped.stationCode },
      stationCandidates(ref.stations),
    ),
    `Station "${mapped.stationCode ?? "?"}"`,
  );
  if (menuItemMatch.error) errors.push(required(menuItemMatch.error));
  if (stationMatch.error) errors.push(required(stationMatch.error));

  let productStatus: Classified = {
    status: "new_entity",
    id: null,
    confidence: null,
    evidence: [],
  };
  if (menuItemMatch.id) {
    const existing = ref.existingProducts.find((p) => p.menu_item_id === menuItemMatch.id);
    if (existing) {
      productStatus = {
        status: "exact_match",
        id: existing.id,
        confidence: 1,
        evidence: ["A product already links this dish to a station."],
      };
    }
  }
  const finalStatus = worse(worse(menuItemMatch.status, stationMatch.status), productStatus.status);

  return {
    mappedData: {
      menuItemName: mapped.menuItemName ?? null,
      menuItemId: menuItemMatch.id,
      stationCode: mapped.stationCode ?? null,
      stationId: stationMatch.id,
      sku: mapped.sku ?? null,
      price: price ?? null,
      active: parseBoolean(mapped.active) ?? true,
    },
    matchStatus: finalStatus,
    matchedEntityId: productStatus.id,
    matchedEntityTable: productStatus.id ? "restaurant_products" : null,
    matchConfidence: Math.min(menuItemMatch.confidence ?? 1, stationMatch.confidence ?? 1),
    matchEvidence: [...menuItemMatch.evidence, ...stationMatch.evidence],
    validationErrors: errors,
    severity: computeSeverity(finalStatus, errors),
  };
}

/* ---------------- Variant ---------------- */

export function stageVariantRow(
  mapped: Record<string, string>,
  ref: {
    menuItems: readonly MenuItemRow[];
    products: readonly ProductRow[];
    existingVariants: readonly { id: string; product_id: string; name: string }[];
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.productMenuItemName)
    errors.push(required("Dish/drink this variant belongs to is missing."));
  if (!mapped.name) errors.push(required("Variant name is missing."));
  const price = numField(mapped.price, "Price", errors, { required: true });
  if (price !== undefined && price < 0) errors.push(required("Price cannot be negative."));
  const priceIsDelta = parseBoolean(mapped.priceIsDelta) ?? false;

  const menuItemMatch = classifyExisting(
    matchCatalogItem({ name: mapped.productMenuItemName }, menuItemCandidates(ref.menuItems)),
    `Dish/drink "${mapped.productMenuItemName ?? "?"}"`,
  );
  let productId: string | null = null;
  let chainStatus: MatchStatus = menuItemMatch.status;
  if (menuItemMatch.error) errors.push(required(menuItemMatch.error));
  if (menuItemMatch.id) {
    const product = ref.products.find((p) => p.menu_item_id === menuItemMatch.id);
    if (product) productId = product.id;
    else {
      errors.push(
        required(
          `Dish "${mapped.productMenuItemName}" has no product/station link yet — import the product/station relationship first, then re-stage this sheet.`,
        ),
      );
      chainStatus = "unmatched";
    }
  }

  let variantStatus: Classified = {
    status: "new_entity",
    id: null,
    confidence: null,
    evidence: [],
  };
  if (productId) {
    const existing = ref.existingVariants.find(
      (v) =>
        v.product_id === productId &&
        v.name.trim().toLowerCase() === (mapped.name ?? "").trim().toLowerCase(),
    );
    if (existing) {
      variantStatus = {
        status: "exact_match",
        id: existing.id,
        confidence: 1,
        evidence: ["Existing variant on file"],
      };
    }
  }
  const finalStatus = worse(chainStatus, variantStatus.status);

  return {
    mappedData: {
      productMenuItemName: mapped.productMenuItemName ?? null,
      productId,
      name: mapped.name ?? null,
      sku: mapped.sku ?? null,
      price: price ?? null,
      priceIsDelta,
      active: parseBoolean(mapped.active) ?? true,
    },
    matchStatus: finalStatus,
    matchedEntityId: variantStatus.id,
    matchedEntityTable: variantStatus.id ? "restaurant_product_variants" : null,
    matchConfidence: menuItemMatch.confidence,
    matchEvidence: menuItemMatch.evidence,
    validationErrors: errors,
    severity: computeSeverity(finalStatus, errors),
  };
}

/* ---------------- Modifier group ---------------- */

export function stageModifierGroupRow(
  mapped: Record<string, string>,
  ref: { modifierGroups: readonly ModifierGroupRow[] },
): StageResult {
  const errors: string[] = [];
  if (!mapped.code) errors.push(required("Group code is missing."));
  if (!mapped.name) errors.push(required("Group name is missing."));
  const minSelect = numField(mapped.minSelect, "Min select", errors) ?? 0;
  const maxSelect = numField(mapped.maxSelect, "Max select", errors) ?? 1;
  if (minSelect < 0) errors.push(required("Min select cannot be negative."));
  if (maxSelect < 1) errors.push(required("Max select must be at least 1."));
  if (minSelect > maxSelect) errors.push(required("Min select cannot exceed max select."));
  const required_ = parseBoolean(mapped.required) ?? false;
  if (required_ && minSelect < 1)
    errors.push(
      `A required modifier group should have a min select of at least 1 — left as entered.`,
    );

  const results = matchCatalogItem(
    { sku: mapped.code, name: mapped.name },
    modifierGroupCandidates(ref.modifierGroups),
  );
  const c = classify(results);

  return {
    mappedData: {
      code: mapped.code ?? null,
      name: mapped.name ?? null,
      minSelect,
      maxSelect,
      required: required_,
      active: parseBoolean(mapped.active) ?? true,
    },
    matchStatus: c.status,
    matchedEntityId: c.id,
    matchedEntityTable: c.id ? "restaurant_modifier_groups" : null,
    matchConfidence: c.confidence,
    matchEvidence: c.evidence,
    validationErrors: errors,
    severity: computeSeverity(c.status, errors),
  };
}

/* ---------------- Modifier ---------------- */

export function stageModifierRow(
  mapped: Record<string, string>,
  ref: {
    modifierGroups: readonly ModifierGroupRow[];
    inventoryItems: readonly InventoryItemRow[];
    units: readonly UnitRow[];
    existingModifiers: readonly { id: string; group_id: string; name: string }[];
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.groupCode) errors.push(required("Modifier group is missing."));
  if (!mapped.name) errors.push(required("Modifier name is missing."));
  const priceDelta = numField(mapped.priceDelta, "Price delta", errors) ?? 0;
  const rawEffect = (mapped.effect ?? "none").trim().toLowerCase();
  const effect = rawEffect === "" ? "none" : rawEffect;
  if (effect !== "none" && effect !== "inventory" && effect !== "recipe") {
    errors.push(
      required(`Stock effect "${mapped.effect}" is not recognised — use none or inventory.`),
    );
  }
  if (effect === "recipe") {
    errors.push(
      required(
        'Recipe-effect modifiers are not supported by import — they reference the versioned recipe/production model, not this importer\'s target. Create this modifier manually, or use "inventory" for a direct stock deduction.',
      ),
    );
  }
  const quantity = numField(mapped.quantity, "Quantity consumed", errors) ?? 0;
  const unitRes = resolveUnit(mapped.unitCode, ref.units);
  if (mapped.unitCode && unitRes.status === "unknown") {
    errors.push(`Unit "${mapped.unitCode}" was not recognised — confirm it manually.`);
  }

  const groupMatch = classifyExisting(
    matchCatalogItem(
      { sku: mapped.groupCode, name: mapped.groupCode },
      modifierGroupCandidates(ref.modifierGroups),
    ),
    `Modifier group "${mapped.groupCode ?? "?"}"`,
  );
  if (groupMatch.error) errors.push(required(groupMatch.error));
  let chainStatus: MatchStatus = groupMatch.status;

  let ingredientMatch: (Classified & { error?: string }) | null = null;
  if (effect === "inventory") {
    if (!mapped.ingredientName && !mapped.ingredientSku && !mapped.ingredientBarcode) {
      errors.push(required("A stock-affecting modifier must name the ingredient it consumes."));
      chainStatus = "unmatched";
    } else {
      ingredientMatch = classifyExisting(
        matchCatalogItem(
          {
            barcode: mapped.ingredientBarcode,
            sku: mapped.ingredientSku,
            name: mapped.ingredientName,
          },
          inventoryItemCandidates(ref.inventoryItems),
        ),
        `Ingredient "${mapped.ingredientName ?? mapped.ingredientSku ?? mapped.ingredientBarcode ?? "?"}"`,
      );
      if (ingredientMatch.error) errors.push(required(ingredientMatch.error));
      chainStatus = worse(chainStatus, ingredientMatch.status);
    }
  }

  let modifierStatus: Classified = {
    status: "new_entity",
    id: null,
    confidence: null,
    evidence: [],
  };
  if (groupMatch.id) {
    const existing = ref.existingModifiers.find(
      (m) =>
        m.group_id === groupMatch.id &&
        m.name.trim().toLowerCase() === (mapped.name ?? "").trim().toLowerCase(),
    );
    if (existing) {
      modifierStatus = {
        status: "exact_match",
        id: existing.id,
        confidence: 1,
        evidence: ["Existing modifier on file"],
      };
    }
  }
  const finalStatus = worse(chainStatus, modifierStatus.status);

  return {
    mappedData: {
      groupCode: mapped.groupCode ?? null,
      groupId: groupMatch.id,
      name: mapped.name ?? null,
      priceDelta,
      effect,
      ingredientName: mapped.ingredientName ?? null,
      ingredientSku: mapped.ingredientSku ?? null,
      ingredientBarcode: mapped.ingredientBarcode ?? null,
      inventoryItemId: ingredientMatch?.id ?? null,
      quantity,
      unitId: unitRes.unit?.id ?? null,
      unitCode: mapped.unitCode ?? null,
      active: parseBoolean(mapped.active) ?? true,
    },
    matchStatus: finalStatus,
    matchedEntityId: modifierStatus.id,
    matchedEntityTable: modifierStatus.id ? "restaurant_modifiers" : null,
    matchConfidence: groupMatch.confidence,
    matchEvidence: groupMatch.evidence,
    validationErrors: errors,
    severity: computeSeverity(finalStatus, errors),
  };
}

/* ---------------- Product ↔ modifier group link ---------------- */

export function stageProductModifierGroupRow(
  mapped: Record<string, string>,
  ref: {
    menuItems: readonly MenuItemRow[];
    products: readonly ProductRow[];
    modifierGroups: readonly ModifierGroupRow[];
    existingLinks: readonly { product_id: string; group_id: string }[];
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.productMenuItemName)
    errors.push(required("Dish/drink to attach this modifier group to is missing."));
  if (!mapped.modifierGroupCode) errors.push(required("Modifier group is missing."));
  const sortOrder = numField(mapped.sortOrder, "Sort order", errors) ?? 0;

  const menuItemMatch = classifyExisting(
    matchCatalogItem({ name: mapped.productMenuItemName }, menuItemCandidates(ref.menuItems)),
    `Dish/drink "${mapped.productMenuItemName ?? "?"}"`,
  );
  if (menuItemMatch.error) errors.push(required(menuItemMatch.error));
  let productId: string | null = null;
  let chainStatus: MatchStatus = menuItemMatch.status;
  if (menuItemMatch.id) {
    const product = ref.products.find((p) => p.menu_item_id === menuItemMatch.id);
    if (product) productId = product.id;
    else {
      errors.push(
        required(
          `Dish "${mapped.productMenuItemName}" has no product/station link yet — import the product/station relationship first, then re-stage this sheet.`,
        ),
      );
      chainStatus = "unmatched";
    }
  }

  const groupMatch = classifyExisting(
    matchCatalogItem(
      { sku: mapped.modifierGroupCode, name: mapped.modifierGroupCode },
      modifierGroupCandidates(ref.modifierGroups),
    ),
    `Modifier group "${mapped.modifierGroupCode ?? "?"}"`,
  );
  if (groupMatch.error) errors.push(required(groupMatch.error));
  chainStatus = worse(chainStatus, groupMatch.status);

  let linkStatus: Classified = { status: "new_entity", id: null, confidence: null, evidence: [] };
  if (productId && groupMatch.id) {
    const existing = ref.existingLinks.find(
      (l) => l.product_id === productId && l.group_id === groupMatch.id,
    );
    if (existing) {
      linkStatus = {
        status: "exact_match",
        id: null,
        confidence: 1,
        evidence: ["This modifier group is already attached to this product."],
      };
    }
  }
  const finalStatus = worse(chainStatus, linkStatus.status);

  return {
    mappedData: {
      productMenuItemName: mapped.productMenuItemName ?? null,
      productId,
      modifierGroupCode: mapped.modifierGroupCode ?? null,
      groupId: groupMatch.id,
      sortOrder,
    },
    matchStatus: finalStatus,
    matchedEntityId: null,
    matchedEntityTable: productId && groupMatch.id ? "restaurant_product_modifier_groups" : null,
    matchConfidence: Math.min(menuItemMatch.confidence ?? 1, groupMatch.confidence ?? 1),
    matchEvidence: [...menuItemMatch.evidence, ...groupMatch.evidence],
    validationErrors: errors,
    severity: computeSeverity(finalStatus, errors),
  };
}

/* ---------------- Recipe component (menu item ingredient) ---------------- */

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
