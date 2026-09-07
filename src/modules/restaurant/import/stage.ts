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
  categoryCandidates,
  inventoryItemCandidates,
  menuCandidates,
  menuItemCandidates,
  modifierGroupCandidates,
  productCandidates,
  stationCandidates,
  supplierCandidates,
  type CategoryRow,
  type InventoryItemRow,
  type MenuItemRow,
  type MenuRow,
  type ModifierGroupRow,
  type ProductRow,
  type StationRow,
  type SupplierRow,
} from "./matching-adapters";

export type MatchStatus =
  "new_entity" | "exact_match" | "possible_match" | "ambiguous" | "unmatched" | "invalid";
export type Severity =
  "cannot_map" | "ambiguous_match" | "missing_field" | "new_entity" | "auto_ok";

export interface MatchCandidate {
  id: string;
  label: string;
  score: number;
}

export interface StageResult {
  mappedData: Record<string, unknown>;
  matchStatus: MatchStatus;
  matchedEntityId: string | null;
  matchedEntityTable: string | null;
  matchConfidence: number | null;
  matchEvidence: string[];
  /**
   * The candidates classify() actually ranked this row's own identity
   * against (top 3, score > 0) — how a reviewer resolving an
   * "ambiguous"/"possible_match" row picks a different existing entity than
   * the one auto-selected, instead of only being able to approve or reject.
   * Empty for a relationship reference (classifyExisting) and for a clean
   * new_entity with no candidates at all.
   */
  matchCandidates: MatchCandidate[];
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
  /** Present on a real classify() result; absent on the small ad-hoc "already on file"/"new" placeholders built elsewhere in this file for a relationship link's own identity (those never need a picker — there is nothing to pick between). */
  candidates?: MatchCandidate[];
}

function topCandidates(results: readonly CatalogMatchResult[]): MatchCandidate[] {
  return results
    .filter((r) => r.score > 0)
    .slice(0, 3)
    .map((r) => ({ id: r.candidate.id, label: r.candidate.name, score: r.score }));
}

/**
 * A near-tie between the top two candidates is genuine ambiguity, not just
 * "not sure yet" — checked even at the "exact" confidence tier, since that
 * tier includes a full-name-token match, not only a literal identifier, and
 * two distinct existing items can each fully contain the same word.
 */
function classify(results: readonly CatalogMatchResult[]): Classified {
  const top = results[0];
  const candidates = topCandidates(results);
  if (!top || top.score === 0)
    return { status: "new_entity", id: null, confidence: null, evidence: [], candidates: [] };
  const runnerUp = results[1];
  const tie = runnerUp && runnerUp.score > 0 && runnerUp.score >= top.score - 0.05;
  if (tie) {
    return {
      status: "ambiguous",
      id: top.candidate.id,
      confidence: top.score,
      evidence: top.evidence,
      candidates,
    };
  }
  if (top.confidence === "exact") {
    return {
      status: "exact_match",
      id: top.candidate.id,
      confidence: top.score,
      evidence: top.evidence,
      candidates,
    };
  }
  return {
    status: "possible_match",
    id: top.candidate.id,
    confidence: top.score,
    evidence: top.evidence,
    candidates,
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

/**
 * A row that states its own currency, different from the property's actual
 * currency, is never silently coerced — no FX rate is invented here or
 * anywhere in this pipeline. Advisory only (not REQUIRED): a genuinely
 * multi-currency supplier list is a legitimate source, the human just has to
 * confirm it, same as any other non-blocking finding in this module.
 */
function checkCurrency(raw: string | undefined, propertyCurrency: string, errors: string[]) {
  const stated = raw?.trim().toUpperCase();
  if (!stated) return;
  if (stated !== propertyCurrency.toUpperCase()) {
    errors.push(
      `Row states currency "${stated}" but this property is configured for "${propertyCurrency}" — confirm before approving; no conversion is applied.`,
    );
  }
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
    matchCandidates: c.candidates ?? [],
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
    propertyCurrency?: string;
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.name) errors.push(required("Item name is missing."));
  if (ref.propertyCurrency) checkCurrency(mapped.currency, ref.propertyCurrency, errors);

  const reorderPoint = numField(mapped.reorderPoint, "Reorder point", errors);
  const parLevel = numField(mapped.parLevel, "Par level", errors);
  const averageCost = numField(mapped.averageCost, "Unit cost", errors);
  // Pack size is genuinely optional on a source sheet — an item bought and
  // stocked in the same unit (no case/carton) has an implicit pack size of
  // 1, matching restaurant_inventory_items' own DB default. Left unresolved
  // this used to make commitInventoryItemRow reject the row outright (its
  // own contract requires a positive pack size — see upsertInventoryItem),
  // which was never correct for the ordinary case of a non-cased item.
  const packSize = numField(mapped.packSize, "Pack size", errors) ?? 1;
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

  const purchaseUnitRes = resolveUnit(mapped.purchaseUnitCode, ref.units);
  if (mapped.purchaseUnitCode && purchaseUnitRes.status === "unknown") {
    errors.push(`Purchase unit "${mapped.purchaseUnitCode}" was not recognised.`);
  }
  const consumptionUnitRes = resolveUnit(mapped.consumptionUnitCode, ref.units);
  if (mapped.consumptionUnitCode && consumptionUnitRes.status === "unknown") {
    errors.push(`Consumption unit "${mapped.consumptionUnitCode}" was not recognised.`);
  }
  const contentUnitRes = resolveUnit(mapped.contentUnitCode, ref.units);
  if (mapped.contentUnitCode && contentUnitRes.status === "unknown") {
    errors.push(`Content unit "${mapped.contentUnitCode}" was not recognised.`);
  }
  const contentPerStockUnit = numField(
    mapped.contentPerStockUnit,
    "Content per stock unit",
    errors,
  );
  // Content per stock unit and content unit are a pair — one without the
  // other is a modelling error the reference screen calls out by name (see
  // the master template's own House Red Wine example): a bottle whose
  // "content" is "750" with no unit, or a unit with no quantity, means
  // nothing on its own. This is deliberately a distinct pair from
  // servingSize/servingUnitCode (the Bar Pour Setup's own "how much per
  // glass") — see restaurant_inventory_items' content_per_stock_unit vs
  // serving_size columns.
  if (
    (mapped.contentPerStockUnit && !mapped.contentUnitCode) ||
    (!mapped.contentPerStockUnit && mapped.contentUnitCode)
  ) {
    errors.push(
      `"${mapped.name ?? "This item"}" gives a content ${mapped.contentPerStockUnit ? "quantity" : "unit"} but not the ${mapped.contentPerStockUnit ? "unit" : "quantity"} — both Content per Stock Unit and Content Unit are needed together, or neither.`,
    );
  }
  const isBeverage = parseBoolean(mapped.isBeverage);
  const shelfLifeDays = numField(mapped.shelfLifeDays, "Shelf life", errors);

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
      currency: mapped.currency ?? null,
      openingQuantity: openingQuantity ?? null,
      openingUnitId: openingUnitRes.unit?.id ?? null,
      openingUnit: mapped.openingUnit ?? null,
      purchaseUnitId: purchaseUnitRes.unit?.id ?? null,
      purchaseUnitCode: mapped.purchaseUnitCode ?? null,
      consumptionUnitId: consumptionUnitRes.unit?.id ?? null,
      consumptionUnitCode: mapped.consumptionUnitCode ?? null,
      contentPerStockUnit: contentPerStockUnit ?? null,
      contentUnitId: contentUnitRes.unit?.id ?? null,
      contentUnitCode: mapped.contentUnitCode ?? null,
      isBeverage: isBeverage ?? null,
      shelfLifeDays: shelfLifeDays ?? null,
    },
    matchStatus: c.status,
    matchedEntityId: c.id,
    matchedEntityTable: c.id ? "restaurant_inventory_items" : null,
    matchConfidence: c.confidence,
    matchEvidence: c.evidence,
    matchCandidates: c.candidates ?? [],
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
    units?: readonly UnitRow[];
    propertyCurrency?: string;
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.supplierName && !mapped.supplierCode)
    errors.push(required("Supplier to link is missing (name or code)."));
  if (!mapped.itemName && !mapped.itemSku && !mapped.itemBarcode)
    errors.push(required("Item to link is missing (name, SKU or barcode)."));
  if (ref.propertyCurrency) checkCurrency(mapped.currency, ref.propertyCurrency, errors);
  const unitPrice = numField(mapped.unitPrice, "Unit price", errors, { required: true });
  const packSize = numField(mapped.packSize, "Pack size", errors);
  const minOrderQuantity = numField(mapped.minOrderQuantity, "Minimum order quantity", errors);
  const leadTimeDays = numField(mapped.leadTimeDays, "Lead time", errors);
  const unitRes = resolveUnit(mapped.unitCode, ref.units ?? []);
  if (mapped.unitCode && unitRes.status === "unknown") {
    errors.push(`Purchase unit "${mapped.unitCode}" was not recognised.`);
  }

  const supplierMatch = classifyExisting(
    matchCatalogItem(
      { sku: mapped.supplierCode, name: mapped.supplierName },
      supplierCandidates(ref.suppliers),
    ),
    `Supplier "${mapped.supplierName ?? mapped.supplierCode ?? "?"}"`,
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
    matchCandidates: [],
    mappedData: {
      supplierName: mapped.supplierName ?? null,
      supplierCode: mapped.supplierCode ?? null,
      supplierId: supplierMatch.id,
      itemName: mapped.itemName ?? null,
      itemSku: mapped.itemSku ?? null,
      itemBarcode: mapped.itemBarcode ?? null,
      inventoryItemId: itemMatch.id,
      supplierSku: mapped.supplierSku ?? null,
      barcode: mapped.itemBarcode ?? null,
      name: mapped.name ?? mapped.itemName ?? null,
      unitCode: mapped.unitCode ?? null,
      unitId: unitRes.unit?.id ?? null,
      packSize: packSize ?? null,
      unitPrice: unitPrice ?? null,
      currency: mapped.currency ?? null,
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

/* ---------------- Menu ---------------- */

const MENU_STATUS_ALIASES: Record<string, string> = {
  draft: "draft",
  published: "published",
  live: "published",
  active: "published",
  archived: "archived",
};

export function stageMenuRow(
  mapped: Record<string, string>,
  ref: { menus: readonly MenuRow[] },
): StageResult {
  const errors: string[] = [];
  if (!mapped.code) errors.push(required("Menu code is missing."));
  if (!mapped.name) errors.push(required("Menu name is missing."));
  const statusRaw = mapped.status?.trim().toLowerCase();
  const status = statusRaw ? (MENU_STATUS_ALIASES[statusRaw] ?? null) : null;
  if (statusRaw && !status) {
    errors.push(
      `Status "${mapped.status}" was not recognised — use Draft, Published or Archived. Left as Draft.`,
    );
  }

  const results = matchCatalogItem(
    { sku: mapped.code, name: mapped.name },
    menuCandidates(ref.menus),
  );
  const c = classify(results);

  return {
    mappedData: {
      code: mapped.code ?? null,
      name: mapped.name ?? null,
      serviceType: mapped.serviceType ?? null,
      status: status ?? "draft",
      currency: mapped.currency ?? null,
      description: mapped.description ?? null,
    },
    matchStatus: c.status,
    matchedEntityId: c.id,
    matchedEntityTable: c.id ? "restaurant_menus" : null,
    matchConfidence: c.confidence,
    matchEvidence: c.evidence,
    matchCandidates: c.candidates ?? [],
    validationErrors: errors,
    severity: computeSeverity(c.status, errors),
  };
}

/* ---------------- Category ---------------- */

export function stageCategoryRow(
  mapped: Record<string, string>,
  ref: { categories: readonly CategoryRow[]; menus: readonly MenuRow[] },
): StageResult {
  const errors: string[] = [];
  if (!mapped.code) errors.push(required("Category code is missing."));
  if (!mapped.name) errors.push(required("Category name is missing."));
  const sortOrder = numField(mapped.sortOrder, "Sort order", errors) ?? 0;

  // Advisory only — restaurant_categories has no menu_id column (categories
  // are shared tenant-wide per kind, see menu.server.ts#upsertCategory), so
  // an unrecognised Menu Code never blocks the category itself. It still
  // catches a real typo before the customer notices a category "missing"
  // from a menu that was really just a mismatched code.
  if (mapped.menuCode) {
    const menuMatch = matchCatalogItem(
      { sku: mapped.menuCode, name: mapped.menuCode },
      menuCandidates(ref.menus),
    );
    if (!menuMatch[0] || menuMatch[0].score === 0) {
      errors.push(
        `Menu "${mapped.menuCode}" was not found — this category will still be created, but confirm the menu code.`,
      );
    }
  }

  const results = matchCatalogItem(
    { sku: mapped.code, name: mapped.name },
    categoryCandidates(ref.categories),
  );
  const c = classify(results);

  return {
    mappedData: {
      menuCode: mapped.menuCode ?? null,
      code: mapped.code ?? null,
      name: mapped.name ?? null,
      sortOrder,
    },
    matchStatus: c.status,
    matchedEntityId: c.id,
    matchedEntityTable: c.id ? "restaurant_categories" : null,
    matchConfidence: c.confidence,
    matchEvidence: c.evidence,
    matchCandidates: c.candidates ?? [],
    validationErrors: errors,
    severity: computeSeverity(c.status, errors),
  };
}

/* ---------------- Menu item ---------------- */

export function stageMenuItemRow(
  mapped: Record<string, string>,
  ref: {
    menuItems: readonly MenuItemRow[];
    categories: readonly CategoryRow[];
    menus?: readonly MenuRow[];
    propertyCurrency?: string;
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.name) errors.push(required("Dish/drink name is missing."));
  if (ref.propertyCurrency) checkCurrency(mapped.currency, ref.propertyCurrency, errors);
  const price = numField(mapped.price, "Price", errors, { required: true });

  // A code is the primary key — resolved by exact match against the menus/
  // categories already staged and committed earlier in this same import (see
  // IMPORT_DOMAIN_COMMIT_ORDER: menu and category both land before
  // menu_item). Only when no code is given at all does this fall back to the
  // existing free-text categoryName match, exactly as before — a sheet with
  // no Menu Code/Category Code column (like the existing O12 workbook, or
  // any other Advanced Import source) behaves identically to today.
  let menuId: string | null = null;
  if (mapped.menuCode && ref.menus) {
    const menuMatch = classifyExisting(
      matchCatalogItem({ sku: mapped.menuCode, name: mapped.menuCode }, menuCandidates(ref.menus)),
      `Menu "${mapped.menuCode}"`,
    );
    if (menuMatch.error) errors.push(required(menuMatch.error));
    menuId = menuMatch.id;
  }

  let categoryId: string | null = null;
  if (mapped.categoryCode) {
    const catMatch = classifyExisting(
      matchCatalogItem(
        { sku: mapped.categoryCode, name: mapped.categoryCode },
        categoryCandidates(ref.categories),
      ),
      `Category "${mapped.categoryCode}"`,
    );
    if (catMatch.id) categoryId = catMatch.id;
    else errors.push(`Category "${mapped.categoryCode}" not found — will be left uncategorised.`);
  } else if (mapped.categoryName) {
    const cat = ref.categories.find(
      (c) => c.name.toLowerCase() === mapped.categoryName!.toLowerCase(),
    );
    if (cat) categoryId = cat.id;
    else errors.push(`Category "${mapped.categoryName}" not found — will be left uncategorised.`);
  }

  const results = matchCatalogItem({ name: mapped.name }, menuItemCandidates(ref.menuItems));
  const c = classify(results);
  const available = parseBoolean(mapped.available);
  const sortOrder = numField(mapped.sortOrder, "Sort order", errors) ?? 0;

  return {
    mappedData: {
      name: mapped.name ?? null,
      menuId,
      menuCode: mapped.menuCode ?? null,
      categoryId,
      categoryCode: mapped.categoryCode ?? null,
      categoryName: mapped.categoryName ?? null,
      description: mapped.description ?? null,
      price: price ?? null,
      currency: mapped.currency ?? null,
      available: available ?? true,
      sortOrder,
    },
    matchStatus: c.status,
    matchedEntityId: c.id,
    matchedEntityTable: c.id ? "restaurant_menu_items" : null,
    matchConfidence: c.confidence,
    matchEvidence: c.evidence,
    matchCandidates: c.candidates ?? [],
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
    matchCandidates: [],
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
  if (!mapped.itemCode && !mapped.productMenuItemName)
    errors.push(required("Dish/drink this variant belongs to is missing."));
  if (!mapped.name) errors.push(required("Variant name is missing."));
  const price = numField(mapped.price, "Price", errors, { required: true });
  if (price !== undefined && price < 0) errors.push(required("Price cannot be negative."));
  const priceIsDelta = parseBoolean(mapped.priceIsDelta) ?? false;

  // A code resolves directly against the product bridge row's own SKU — no
  // fuzzy name step, and no dependency on the menu item's own identity at
  // all (a product's sku is stable even if the dish is later renamed). Only
  // absent a code does this fall back to the existing name -> menu item ->
  // product chain, unchanged from before.
  let productId: string | null = null;
  let chainStatus: MatchStatus = "new_entity";
  let chainConfidence: number | null = null;
  let chainEvidence: string[] = [];
  if (mapped.itemCode) {
    const productMatch = classifyExisting(
      matchCatalogItem({ sku: mapped.itemCode }, productCandidates(ref.products)),
      `Item "${mapped.itemCode}"`,
    );
    if (productMatch.error) errors.push(required(productMatch.error));
    productId = productMatch.id;
    chainStatus = productMatch.status;
    chainConfidence = productMatch.confidence;
    chainEvidence = productMatch.evidence;
  } else {
    const menuItemMatch = classifyExisting(
      matchCatalogItem({ name: mapped.productMenuItemName }, menuItemCandidates(ref.menuItems)),
      `Dish/drink "${mapped.productMenuItemName ?? "?"}"`,
    );
    chainStatus = menuItemMatch.status;
    chainConfidence = menuItemMatch.confidence;
    chainEvidence = menuItemMatch.evidence;
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
    matchCandidates: [],
    mappedData: {
      itemCode: mapped.itemCode ?? null,
      productMenuItemName: mapped.productMenuItemName ?? null,
      productId,
      name: mapped.name ?? null,
      sku: mapped.sku ?? null,
      price: price ?? null,
      priceIsDelta,
      active: parseBoolean(mapped.active) ?? true,
      sortOrder: numField(mapped.sortOrder, "Sort order", errors) ?? 0,
    },
    matchStatus: finalStatus,
    matchedEntityId: variantStatus.id,
    matchedEntityTable: variantStatus.id ? "restaurant_product_variants" : null,
    matchConfidence: chainConfidence,
    matchEvidence: chainEvidence,
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
      sortOrder: numField(mapped.sortOrder, "Sort order", errors) ?? 0,
    },
    matchStatus: c.status,
    matchedEntityId: c.id,
    matchedEntityTable: c.id ? "restaurant_modifier_groups" : null,
    matchConfidence: c.confidence,
    matchEvidence: c.evidence,
    matchCandidates: c.candidates ?? [],
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
    matchCandidates: [],
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
      sortOrder: numField(mapped.sortOrder, "Sort order", errors) ?? 0,
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
  if (!mapped.itemCode && !mapped.productMenuItemName)
    errors.push(required("Dish/drink to attach this modifier group to is missing."));
  if (!mapped.modifierGroupCode) errors.push(required("Modifier group is missing."));
  const sortOrder = numField(mapped.sortOrder, "Sort order", errors) ?? 0;

  // Same code-first, name-fallback resolution as stageVariantRow — see its
  // own comment for why a code skips the menu-item hop entirely.
  let productId: string | null = null;
  let chainStatus: MatchStatus = "new_entity";
  let chainConfidence: number | null = null;
  let chainEvidence: string[] = [];
  if (mapped.itemCode) {
    const productMatch = classifyExisting(
      matchCatalogItem({ sku: mapped.itemCode }, productCandidates(ref.products)),
      `Item "${mapped.itemCode}"`,
    );
    if (productMatch.error) errors.push(required(productMatch.error));
    productId = productMatch.id;
    chainStatus = productMatch.status;
    chainConfidence = productMatch.confidence;
    chainEvidence = productMatch.evidence;
  } else {
    const menuItemMatch = classifyExisting(
      matchCatalogItem({ name: mapped.productMenuItemName }, menuItemCandidates(ref.menuItems)),
      `Dish/drink "${mapped.productMenuItemName ?? "?"}"`,
    );
    if (menuItemMatch.error) errors.push(required(menuItemMatch.error));
    chainStatus = menuItemMatch.status;
    chainConfidence = menuItemMatch.confidence;
    chainEvidence = menuItemMatch.evidence;
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
    matchCandidates: [],
    mappedData: {
      itemCode: mapped.itemCode ?? null,
      productMenuItemName: mapped.productMenuItemName ?? null,
      productId,
      modifierGroupCode: mapped.modifierGroupCode ?? null,
      groupId: groupMatch.id,
      sortOrder,
    },
    matchStatus: finalStatus,
    matchedEntityId: null,
    matchedEntityTable: productId && groupMatch.id ? "restaurant_product_modifier_groups" : null,
    matchConfidence: Math.min(chainConfidence ?? 1, groupMatch.confidence ?? 1),
    matchEvidence: [...chainEvidence, ...groupMatch.evidence],
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
    /** Optional — only needed to resolve itemCode. Absent ref.products with an itemCode-only row degrades gracefully to "not found", same as any other unmatched reference. */
    products?: readonly ProductRow[];
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.itemCode && !mapped.menuItemName)
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

  // A code resolves through the product bridge row (restaurant_products,
  // matched by its own sku) straight to its menu_item_id — the same code
  // stageVariantRow/stageProductModifierGroupRow use, since restaurant_
  // recipe_components stores menu_item_id directly rather than product_id.
  // Falls back to the existing name match when no code is given.
  let menuItemId: string | null = null;
  let menuItemStatus: MatchStatus = "new_entity";
  let menuItemConfidence: number | null = null;
  let menuItemEvidence: string[] = [];
  if (mapped.itemCode) {
    const productMatch = classifyExisting(
      matchCatalogItem({ sku: mapped.itemCode }, productCandidates(ref.products ?? [])),
      `Item "${mapped.itemCode}"`,
    );
    if (productMatch.error) errors.push(required(productMatch.error));
    menuItemStatus = productMatch.status;
    menuItemConfidence = productMatch.confidence;
    menuItemEvidence = productMatch.evidence;
    if (productMatch.id) {
      const product = (ref.products ?? []).find((p) => p.id === productMatch.id);
      menuItemId = product?.menu_item_id ?? null;
      if (!menuItemId) {
        errors.push(required(`Item "${mapped.itemCode}" has no dish linked to it yet.`));
        menuItemStatus = "unmatched";
      }
    }
  } else {
    const menuItemMatch = classifyExisting(
      matchCatalogItem({ name: mapped.menuItemName }, menuItemCandidates(ref.menuItems)),
      `Dish/drink "${mapped.menuItemName ?? "?"}"`,
    );
    if (menuItemMatch.error) errors.push(required(menuItemMatch.error));
    menuItemId = menuItemMatch.id;
    menuItemStatus = menuItemMatch.status;
    menuItemConfidence = menuItemMatch.confidence;
    menuItemEvidence = menuItemMatch.evidence;
  }

  const ingredientMatch = classifyExisting(
    matchCatalogItem(
      { barcode: mapped.ingredientBarcode, sku: mapped.ingredientSku, name: mapped.ingredientName },
      inventoryItemCandidates(ref.inventoryItems),
    ),
    `Ingredient "${mapped.ingredientName ?? mapped.ingredientSku ?? mapped.ingredientBarcode ?? "?"}"`,
  );
  if (ingredientMatch.error) errors.push(required(ingredientMatch.error));

  const overallStatus = worse(menuItemStatus, ingredientMatch.status);

  return {
    matchCandidates: [],
    mappedData: {
      itemCode: mapped.itemCode ?? null,
      menuItemName: mapped.menuItemName ?? null,
      menuItemId,
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
    matchConfidence: Math.min(menuItemConfidence ?? 1, ingredientMatch.confidence ?? 1),
    matchEvidence: [...menuItemEvidence, ...ingredientMatch.evidence],
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
    propertyCurrency?: string;
  },
): StageResult {
  const errors: string[] = [];
  if (!mapped.itemName && !mapped.itemSku && !mapped.itemBarcode)
    errors.push(required("Item to stock is missing (name, SKU or barcode)."));
  if (ref.propertyCurrency) checkCurrency(mapped.currency, ref.propertyCurrency, errors);
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
    matchCandidates: [],
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
      currency: mapped.currency ?? null,
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
