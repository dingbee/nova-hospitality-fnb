/**
 * LexiBite Import Template — the single canonical definition of the
 * downloadable "LexiBite Import Template" workbook.
 *
 * Nothing about the template's shape is duplicated anywhere else: this one
 * module is read by the client-side workbook generator (template-xlsx.ts),
 * by template detection and the deterministic import pipeline
 * (template-import.server.ts), and by any documentation surface that needs
 * to describe the template. Every column's `field` is a real canonical
 * field already defined in domains.ts — a LexiBite template sheet is staged
 * by the exact same stage*Row functions Advanced Import uses, not a second
 * parser. See the LexiBite import upgrade spec, Part 18: "Do not hard-code
 * sheet structures in multiple locations."
 *
 * Column headers are written to exactly match an existing canonical field
 * alias (see domains.ts's CANONICAL_FIELDS) so a template sheet needs no
 * special-cased mapping step — suggestFieldMapping already resolves every
 * one of these headers with confidence 1. Where the spec asked for a
 * friendlier header than any existing alias covered (e.g. "Supplier Product
 * Name", "Minimum Selections"), the alias list itself was extended — see
 * domains.ts — rather than inventing a second mapping mechanism here.
 */
import type { ImportDomain } from "./domains";

export const LEXIBITE_TEMPLATE_VERSION = "1.0";
export const LEXIBITE_TEMPLATE_MARKER = "LexiBite Template";
export const LEXIBITE_TEMPLATE_FILENAME = `LexiBite_Import_Template_v${LEXIBITE_TEMPLATE_VERSION}.xlsx`;

export interface TemplateColumn {
  /** Exact column header text — must match an existing canonical field alias for `field`/`domain`. */
  header: string;
  /**
   * The canonical field this column feeds. Omitted for a column that is
   * documentation-only (kept for the customer's own reference, e.g.
   * Inventory's "Type") or a natural-key column already carried under a
   * different sheet's own field (e.g. Modifiers' "Modifier Code" — modifiers
   * are matched by name within their group, not by a separate code).
   */
  field?: string;
  /**
   * The domain this column's `field` belongs to, when it differs from the
   * sheet's own primary `domain`. Only MENU ITEMS uses this: its Item Code
   * and Station columns feed a `product_station` row the deterministic
   * pipeline derives from each menu item row (see template-import.server.ts)
   * — LexiBite's template never asks for a separate "stations" sheet.
   */
  domain?: ImportDomain;
  required?: boolean;
  /** Shown as a cell/column note in the generated workbook. */
  comment?: string;
  /** Dropdown choices, when this column should be a validated list rather than free text. */
  choices?: readonly string[];
}

export interface TemplateSheetDef {
  /** Exact sheet/tab name. */
  name: string;
  /** The domain this sheet stages against. Undefined only for START HERE. */
  domain?: ImportDomain;
  description: string;
  required: boolean;
  columns: readonly TemplateColumn[];
  /**
   * One or more fully worked example rows, keyed by column header. Shown in
   * the workbook styled distinctly from real data (see template-xlsx.ts) —
   * the customer is expected to delete them before adding their own rows,
   * exactly like any other spreadsheet template. If left in place and the
   * workbook is uploaded as-is, they import like any other row: nothing
   * here is silently skipped or specially recognised at import time.
   */
  exampleRows: readonly Record<string, string>[];
}

/**
 * The worked example threaded across every sheet — a small, internally
 * consistent restaurant ("Golden Fork Bistro") whose codes cross-reference
 * correctly, so a customer opening the template sees exactly how the
 * relationships in "How relationships work" (START HERE) look in practice.
 */
export const LEXIBITE_TEMPLATE_SHEETS: readonly TemplateSheetDef[] = [
  {
    name: "SUPPLIERS",
    domain: "supplier",
    description: "Who you buy ingredients and supplies from.",
    required: false,
    columns: [
      {
        header: "Supplier Code",
        field: "code",
        comment: "A short code you choose — used by Supplier Products below to link back here.",
      },
      { header: "Supplier Name", field: "name", required: true },
      { header: "Contact Name", field: "contactName" },
      { header: "Email", field: "email" },
      { header: "Phone", field: "phone" },
      { header: "Address", field: "address" },
      { header: "Payment Terms", field: "paymentTerms", comment: "e.g. Net 30, COD" },
      { header: "Lead Time (Days)", field: "leadTimeDays" },
    ],
    exampleRows: [
      {
        "Supplier Code": "SUP-001",
        "Supplier Name": "Fresh Farms Ltd",
        "Contact Name": "Amina Joseph",
        Email: "amina@freshfarms.example",
        Phone: "+255 700 000 001",
        Address: "Plot 12, Nyerere Road, Dar es Salaam",
        "Payment Terms": "Net 30",
        "Lead Time (Days)": "2",
      },
    ],
  },
  {
    name: "INVENTORY",
    domain: "inventory_item",
    description: "The raw ingredients and stock items you track.",
    required: true,
    columns: [
      {
        header: "SKU",
        field: "sku",
        required: true,
        comment:
          "A short stable code you choose — e.g. CHICK-001. Referenced by Recipes and Supplier Products below.",
      },
      { header: "Item Name", field: "name", required: true },
      {
        header: "Type",
        comment:
          "For your own reference only — not imported. Use Category to group items in LexiBite.",
      },
      { header: "Category", field: "categoryName" },
      {
        header: "Stock Unit",
        field: "unitCode",
        comment: "The unit you count this item in — e.g. KG, BTL, PC. See the unit guide above.",
      },
      {
        header: "Purchase Unit",
        field: "purchaseUnitCode",
        comment: "The unit you buy this item in, if different from the Stock Unit — e.g. CTN.",
      },
      {
        header: "Pack Size",
        field: "packSize",
        comment:
          "How many Stock Units are in one Purchase Unit — e.g. 12 bottles in a carton. NOT the contents of one bottle — see Content per Stock Unit.",
      },
      {
        header: "Consumption Unit",
        field: "consumptionUnitCode",
        comment: "The unit a recipe uses this item in, if different from the Stock Unit — e.g. ML.",
      },
      {
        header: "Content per Stock Unit",
        field: "contentPerStockUnit",
        comment:
          "The quantity inside ONE Stock Unit — e.g. a 750ml bottle has 750 here. Required together with Content Unit, or leave both blank.",
      },
      { header: "Content Unit", field: "contentUnitCode" },
      {
        header: "Opening Quantity",
        field: "openingQuantity",
        comment: "Current stock on hand, in the Stock Unit.",
      },
      { header: "Average Cost", field: "averageCost" },
      {
        header: "Currency",
        field: "currency",
        comment: "Only needed if different from your property's own currency.",
      },
      { header: "Par Level", field: "parLevel" },
      { header: "Reorder Point", field: "reorderPoint" },
      { header: "Brand", field: "brand" },
      { header: "Barcode", field: "barcode" },
      { header: "Shelf Life (Days)", field: "shelfLifeDays" },
      { header: "Is Beverage", field: "isBeverage", choices: ["Yes", "No"] },
    ],
    exampleRows: [
      {
        SKU: "CHICK-001",
        "Item Name": "Chicken Breast",
        Type: "Food",
        Category: "Meat",
        "Stock Unit": "KG",
        "Purchase Unit": "",
        "Pack Size": "",
        "Consumption Unit": "",
        "Content per Stock Unit": "",
        "Content Unit": "",
        "Opening Quantity": "25",
        "Average Cost": "9500",
        Currency: "",
        "Par Level": "40",
        "Reorder Point": "15",
        Brand: "",
        Barcode: "",
        "Shelf Life (Days)": "3",
        "Is Beverage": "No",
      },
      {
        SKU: "CHEESE-001",
        "Item Name": "Cheddar Cheese",
        Type: "Food",
        Category: "Dairy",
        "Stock Unit": "KG",
        "Purchase Unit": "",
        "Pack Size": "",
        "Consumption Unit": "",
        "Content per Stock Unit": "",
        "Content Unit": "",
        "Opening Quantity": "8",
        "Average Cost": "14000",
        Currency: "",
        "Par Level": "10",
        "Reorder Point": "3",
        Brand: "",
        Barcode: "",
        "Shelf Life (Days)": "21",
        "Is Beverage": "No",
      },
      {
        SKU: "WINE-RED-750",
        "Item Name": "House Red Wine",
        Type: "Beverage",
        Category: "Wine",
        "Stock Unit": "BTL",
        "Purchase Unit": "CTN",
        "Pack Size": "12",
        "Consumption Unit": "ML",
        "Content per Stock Unit": "750",
        "Content Unit": "ML",
        "Opening Quantity": "36",
        "Average Cost": "12000",
        Currency: "",
        "Par Level": "48",
        "Reorder Point": "12",
        Brand: "",
        Barcode: "",
        "Shelf Life (Days)": "",
        "Is Beverage": "Yes",
      },
    ],
  },
  {
    name: "SUPPLIER PRODUCTS",
    domain: "supplier_product",
    description: "What each supplier sells you, and at what price.",
    required: false,
    columns: [
      { header: "Supplier Code", field: "supplierCode", required: true },
      { header: "Inventory SKU", field: "itemSku", required: true },
      { header: "Supplier SKU", field: "supplierSku" },
      { header: "Supplier Product Name", field: "name" },
      { header: "Barcode", field: "itemBarcode" },
      { header: "Purchase Unit", field: "unitCode" },
      { header: "Pack Size", field: "packSize" },
      { header: "Unit Price", field: "unitPrice", required: true },
      { header: "Currency", field: "currency" },
      { header: "Minimum Order Quantity", field: "minOrderQuantity" },
      { header: "Lead Time (Days)", field: "leadTimeDays" },
    ],
    exampleRows: [
      {
        "Supplier Code": "SUP-001",
        "Inventory SKU": "CHICK-001",
        "Supplier SKU": "FF-CHK-01",
        "Supplier Product Name": "Chicken Breast, boneless",
        Barcode: "",
        "Purchase Unit": "KG",
        "Pack Size": "1",
        "Unit Price": "9200",
        Currency: "",
        "Minimum Order Quantity": "10",
        "Lead Time (Days)": "2",
      },
    ],
  },
  {
    name: "MENUS",
    domain: "menu",
    description: "The menus you serve from (e.g. Main Menu, Bar Menu).",
    required: false,
    columns: [
      {
        header: "Menu Code",
        field: "code",
        required: true,
        comment: "A short code you choose — used by Categories and Menu Items below.",
      },
      { header: "Menu Name", field: "name", required: true },
      { header: "Type", field: "serviceType", comment: "e.g. Food, Drinks, Breakfast" },
      { header: "Status", field: "status", choices: ["Draft", "Published", "Archived"] },
      { header: "Currency", field: "currency" },
      { header: "Description", field: "description" },
    ],
    exampleRows: [
      {
        "Menu Code": "MENU-MAIN",
        "Menu Name": "Main Menu",
        Type: "Food",
        Status: "Draft",
        Currency: "",
        Description: "All-day dining menu",
      },
    ],
  },
  {
    name: "CATEGORIES",
    domain: "category",
    description: "How menu items are grouped (e.g. Starters, Burgers).",
    required: false,
    columns: [
      {
        header: "Menu Code",
        field: "menuCode",
        comment:
          "Cross-checked against Menus above — categories are shared across your whole restaurant, not owned by one menu.",
      },
      {
        header: "Category Code",
        field: "code",
        required: true,
        comment: "A short code you choose — used by Menu Items below.",
      },
      { header: "Category Name", field: "name", required: true },
      { header: "Sort Order", field: "sortOrder" },
    ],
    exampleRows: [
      {
        "Menu Code": "MENU-MAIN",
        "Category Code": "CAT-BURG",
        "Category Name": "Burgers",
        "Sort Order": "1",
      },
    ],
  },
  {
    name: "MENU ITEMS",
    domain: "menu_item",
    description: "The dishes and drinks guests order.",
    required: true,
    columns: [
      {
        header: "Item Code",
        field: "sku",
        domain: "product_station",
        required: true,
        comment: "A short code you choose — used by Variants, Item Modifiers and Recipes below.",
      },
      { header: "Menu Code", field: "menuCode" },
      { header: "Category Code", field: "categoryCode" },
      { header: "Item Name", field: "name", required: true },
      { header: "Description", field: "description" },
      { header: "Selling Price", field: "price", required: true },
      { header: "Currency", field: "currency" },
      {
        header: "Station",
        field: "stationCode",
        domain: "product_station",
        required: true,
        comment: "Where this item is produced.",
        choices: ["Kitchen", "Grill", "Bar", "Cocktail", "Coffee", "Service Bar", "Beverage"],
      },
      { header: "Available", field: "available", choices: ["Yes", "No"] },
      { header: "Sort Order", field: "sortOrder" },
    ],
    exampleRows: [
      {
        "Item Code": "BURG-001",
        "Menu Code": "MENU-MAIN",
        "Category Code": "CAT-BURG",
        "Item Name": "Classic Chicken Burger",
        Description: "Grilled chicken breast, lettuce, house sauce",
        "Selling Price": "18000",
        Currency: "",
        Station: "Kitchen",
        Available: "Yes",
        "Sort Order": "1",
      },
    ],
  },
  {
    name: "VARIANTS",
    domain: "variant",
    description: "Size or option choices for a menu item (e.g. Regular/Large).",
    required: false,
    columns: [
      { header: "Item Code", field: "itemCode", required: true },
      { header: "Variant Code", field: "sku" },
      { header: "Variant Name", field: "name", required: true },
      {
        header: "Price Delta",
        field: "price",
        required: true,
        comment: "The amount added to (or, if negative, subtracted from) the item's Selling Price.",
      },
      {
        header: "Pricing Method",
        field: "priceIsDelta",
        choices: ["Delta", "Absolute"],
        comment:
          "Delta (the usual case): Price Delta is added to the item's price. Absolute: Price Delta is the variant's whole price.",
      },
      { header: "Active", field: "active", choices: ["Yes", "No"] },
      { header: "Sort Order", field: "sortOrder" },
    ],
    exampleRows: [
      {
        "Item Code": "BURG-001",
        "Variant Code": "BURG-001-LG",
        "Variant Name": "Large",
        "Price Delta": "2000",
        "Pricing Method": "Delta",
        Active: "Yes",
        "Sort Order": "1",
      },
    ],
  },
  {
    name: "MODIFIER GROUPS",
    domain: "modifier_group",
    description: "A set of choices a guest picks from for an item (e.g. Extras).",
    required: false,
    columns: [
      {
        header: "Group Code",
        field: "code",
        required: true,
        comment: "A short code you choose — used by Modifiers and Item Modifiers below.",
      },
      { header: "Group Name", field: "name", required: true },
      { header: "Required", field: "required", choices: ["Yes", "No"] },
      { header: "Minimum Selections", field: "minSelect" },
      { header: "Maximum Selections", field: "maxSelect" },
      { header: "Active", field: "active", choices: ["Yes", "No"] },
      { header: "Sort Order", field: "sortOrder" },
    ],
    exampleRows: [
      {
        "Group Code": "MOD-EXTRAS",
        "Group Name": "Extras",
        Required: "No",
        "Minimum Selections": "0",
        "Maximum Selections": "3",
        Active: "Yes",
        "Sort Order": "1",
      },
    ],
  },
  {
    name: "MODIFIERS",
    domain: "modifier",
    description: "The individual choices inside a modifier group (e.g. Extra Cheese).",
    required: false,
    columns: [
      { header: "Group Code", field: "groupCode", required: true },
      {
        header: "Modifier Code",
        comment:
          "For your own reference only — modifiers are matched by name within their group, not a separate code.",
      },
      { header: "Modifier Name", field: "name", required: true },
      { header: "Price Delta", field: "priceDelta" },
      {
        header: "Effect",
        field: "effect",
        choices: ["None", "Inventory"],
        comment:
          "Inventory: picking this modifier deducts stock — fill in Inventory SKU/Quantity/Unit below.",
      },
      { header: "Inventory SKU", field: "ingredientSku" },
      { header: "Quantity", field: "quantity" },
      { header: "Unit", field: "unitCode" },
      { header: "Active", field: "active", choices: ["Yes", "No"] },
      { header: "Sort Order", field: "sortOrder" },
    ],
    exampleRows: [
      {
        "Group Code": "MOD-EXTRAS",
        "Modifier Code": "MOD-EXTRAS-CHEESE",
        "Modifier Name": "Extra Cheese",
        "Price Delta": "1000",
        Effect: "Inventory",
        "Inventory SKU": "CHEESE-001",
        Quantity: "0.03",
        Unit: "KG",
        Active: "Yes",
        "Sort Order": "1",
      },
    ],
  },
  {
    name: "ITEM MODIFIERS",
    domain: "product_modifier_group",
    description: "Which modifier groups apply to which menu items.",
    required: false,
    columns: [
      { header: "Item Code", field: "itemCode", required: true },
      { header: "Group Code", field: "modifierGroupCode", required: true },
      { header: "Sort Order", field: "sortOrder" },
    ],
    exampleRows: [{ "Item Code": "BURG-001", "Group Code": "MOD-EXTRAS", "Sort Order": "1" }],
  },
  {
    name: "RECIPES",
    domain: "recipe_component",
    description: "What ingredients each menu item consumes, and how much.",
    required: false,
    columns: [
      { header: "Item Code", field: "itemCode", required: true },
      { header: "Ingredient SKU", field: "ingredientSku", required: true },
      { header: "Quantity", field: "quantity", required: true },
      { header: "Unit", field: "unitCode" },
      {
        header: "Yield",
        field: "yieldPercent",
        comment: "The usable percentage after prep loss — e.g. 92 for 92%. Leave blank for 100%.",
      },
      { header: "Notes", field: "notes" },
    ],
    exampleRows: [
      {
        "Item Code": "BURG-001",
        "Ingredient SKU": "CHICK-001",
        Quantity: "0.18",
        Unit: "KG",
        Yield: "",
        Notes: "",
      },
      {
        "Item Code": "BURG-001",
        "Ingredient SKU": "CHEESE-001",
        Quantity: "0.02",
        Unit: "KG",
        Yield: "",
        Notes: "",
      },
    ],
  },
];

/** Every operational sheet name, in workbook order — used by detection and by the deterministic import pipeline. */
export const LEXIBITE_TEMPLATE_SHEET_NAMES: readonly string[] = LEXIBITE_TEMPLATE_SHEETS.map(
  (s) => s.name,
);

export function templateSheetByName(name: string): TemplateSheetDef | undefined {
  const normalized = name.trim().toUpperCase();
  return LEXIBITE_TEMPLATE_SHEETS.find((s) => s.name.toUpperCase() === normalized);
}

/** Compact unit guide shown on START HERE — every code the template's Unit columns accept. */
export const LEXIBITE_UNIT_GUIDE: readonly { code: string; meaning: string }[] = [
  { code: "KG", meaning: "Kilogram" },
  { code: "G", meaning: "Gram" },
  { code: "L", meaning: "Litre" },
  { code: "ML", meaning: "Millilitre" },
  { code: "PC", meaning: "Piece / each" },
  { code: "BTL", meaning: "Bottle" },
  { code: "CTN", meaning: "Carton / case" },
];

export interface TemplateDetectionResult {
  isTemplate: boolean;
  version: string | null;
  markerFound: boolean;
  matchedSheetNames: string[];
  missingRequiredSheetNames: string[];
}

/**
 * Recognises an uploaded workbook as a LexiBite Import Template — never by
 * filename alone (Part 6 of the LexiBite import upgrade spec). Two
 * independent signals, either sufficient on its own: the literal marker
 * text (written into both the visible START HERE sheet and the hidden
 * `_lexibite_meta` sheet by template-xlsx.ts — a customer who deletes one
 * copy is still caught by the other), or a structural match (every required
 * sheet present by name, and most of the eleven operational sheet names
 * present). Structural-only detection matters too: a customer who deletes
 * the whole START HERE sheet but keeps filling in their data should still
 * get the deterministic path, not be silently downgraded to Advanced Import.
 */
export function detectLexibiteTemplate(
  sheets: readonly {
    sheetName: string;
    headers: readonly string[];
    rows: readonly Record<string, string>[];
  }[],
): TemplateDetectionResult {
  const sheetNamesUpper = sheets.map((s) => s.sheetName.trim().toUpperCase());
  const matchedSheetNames = LEXIBITE_TEMPLATE_SHEET_NAMES.filter((name) =>
    sheetNamesUpper.includes(name),
  );
  const requiredSheetNames = LEXIBITE_TEMPLATE_SHEETS.filter((s) => s.required).map((s) => s.name);
  const missingRequiredSheetNames = requiredSheetNames.filter(
    (name) => !sheetNamesUpper.includes(name),
  );

  let markerFound = false;
  let version: string | null = null;
  for (const sheet of sheets) {
    const cells = [...sheet.headers, ...sheet.rows.flatMap((r) => Object.values(r))];
    for (const cell of cells) {
      if (!cell) continue;
      if (cell.includes(LEXIBITE_TEMPLATE_MARKER)) markerFound = true;
      const m = /Template Version:\s*([\d.]+)/.exec(cell);
      if (m) version = m[1] ?? null;
    }
  }

  const structuralMatch = missingRequiredSheetNames.length === 0 && matchedSheetNames.length >= 6;

  return {
    isTemplate: markerFound || structuralMatch,
    version,
    markerFound,
    matchedSheetNames,
    missingRequiredSheetNames,
  };
}

/** START HERE sheet content — structured so template-xlsx.ts lays it out, not prose baked into a formatter. */
export const LEXIBITE_START_HERE = {
  title: "Welcome to LexiBite",
  intro:
    "This workbook is the fastest, most reliable way to bring your restaurant's data into LexiBite. Fill in the sheets that apply to you, then upload this file from Import Studio.",
  steps: [
    "Complete the sheets relevant to your restaurant — see Required vs Optional below.",
    "Use short, stable codes consistently (e.g. the same Supplier Code everywhere it's referenced) — see the examples in each sheet.",
    "Keep names human-readable — they're what your team will see in LexiBite.",
    "Save the file and upload it from Import Studio.",
    "LexiBite checks everything before anything goes live — you approve what gets imported.",
  ],
  requiredSheets: ["INVENTORY", "MENU ITEMS"],
  optionalSheets: [
    "SUPPLIERS",
    "SUPPLIER PRODUCTS",
    "MENUS",
    "CATEGORIES",
    "VARIANTS",
    "MODIFIER GROUPS",
    "MODIFIERS",
    "ITEM MODIFIERS",
    "RECIPES",
  ],
  relationships: [
    "Supplier -> Supplier Product -> Inventory Item",
    "Menu -> Category -> Menu Item",
    "Menu Item -> Variant / Modifier Groups / Recipe -> Inventory Items",
  ],
  codeExamples: [
    { kind: "Inventory SKU", example: "CHICK-001" },
    { kind: "Menu Item Code", example: "BURG-001" },
    { kind: "Supplier Code", example: "SUP-001" },
  ],
  codeExamplesNote: "Codes are stable identifiers you choose — never a database ID.",
} as const;
