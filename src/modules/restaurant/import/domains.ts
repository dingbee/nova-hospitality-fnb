/**
 * O7/O8 Import Studio — the canonical import map.
 *
 * One domain = one kind of staged record = one existing write-path service
 * function it eventually becomes, at commit time only:
 *
 *   supplier                -> suppliers.server.ts#upsertSupplier
 *   inventory_item           -> inventory/inventory.server.ts#upsertInventoryItem
 *   supplier_product         -> suppliers.server.ts#upsertSupplierProduct
 *   menu_item                 -> menu/menu.server.ts#upsertMenuItem
 *   product_station           -> products/products.server.ts#upsertProduct
 *   variant                   -> products/products.server.ts#upsertVariant
 *   modifier_group             -> products/products.server.ts#upsertModifierGroup
 *   modifier                   -> products/products.server.ts#upsertModifier
 *   product_modifier_group     -> products/products.server.ts#attachModifierGroup
 *   recipe_component           -> costing/costing.server.ts#upsertRecipeComponent
 *   opening_stock               -> inventory/movements.server.ts#insertMovement
 *                                  (movementType: "opening_balance")
 *
 * recipe_component targets restaurant_recipe_components (menu_item_id
 * direct), not restaurant_recipes/restaurant_recipe_lines — that second,
 * versioned recipe system exists in this codebase for restaurant_products
 * (station-routed POS/production items), but it is restaurant_recipe_
 * components that consumeForOrderItem (inventory/movements.server.ts) and
 * computeRecipeCost (costing/costing.server.ts) actually read at order-close
 * and for menu costing/lifecycle gating today — that is the system that is
 * live end-to-end, so it is the one this importer targets. See the O7 final
 * report for the full architecture note.
 *
 * O8 adds the five domains a guest actually sees on the ordering screen:
 * `restaurant_products` is the bridge a menu item needs before it can carry a
 * variant, a modifier group or a station — see pos.server.ts#fetchSellable
 * Catalog, which only surfaces variants/modifiers for a menu item once a
 * `restaurant_products` row with that menu_item_id exists. `product_station`
 * creates/matches that bridge row (and its station); `variant`, `modifier_
 * group`, `modifier` and `product_modifier_group` all depend on it existing
 * first. A modifier's optional `effect: "recipe"` is deliberately not
 * supported here — that would require staging against restaurant_recipes,
 * the other (non-live) recipe model this importer does not touch.
 *
 * No canonical field here is invented: every one is a field an existing
 * upsert* function already accepts.
 */

export const IMPORT_DOMAINS = [
  "supplier",
  "inventory_item",
  "supplier_product",
  "menu_item",
  "product_station",
  "variant",
  "modifier_group",
  "modifier",
  "product_modifier_group",
  "recipe_component",
  "opening_stock",
] as const;
export type ImportDomain = (typeof IMPORT_DOMAINS)[number];

export const IMPORT_DOMAIN_LABELS: Record<ImportDomain, string> = {
  supplier: "Suppliers",
  inventory_item: "Inventory items",
  supplier_product: "Supplier products",
  menu_item: "Menu items",
  product_station: "Products (menu item ↔ station)",
  variant: "Variants",
  modifier_group: "Modifier groups",
  modifier: "Modifiers",
  product_modifier_group: "Product ↔ modifier group links",
  recipe_component: "Recipe ingredients",
  opening_stock: "Opening stock",
};

/**
 * Commit dependency order — a later domain may reference an entity resolved
 * by an earlier one. `product_station` must land before `variant`,
 * `modifier`/`product_modifier_group` must land after `modifier_group`, and
 * `product_modifier_group` must land after `product_station` too.
 */
export const IMPORT_DOMAIN_COMMIT_ORDER: readonly ImportDomain[] = [
  "supplier",
  "inventory_item",
  "supplier_product",
  "menu_item",
  "product_station",
  "variant",
  "modifier_group",
  "modifier",
  "product_modifier_group",
  "recipe_component",
  "opening_stock",
];

export interface CanonicalFieldDef {
  field: string;
  label: string;
  required: boolean;
  /** Normalized (lowercase, alnum-only) header aliases this field is recognised under. */
  aliases: readonly string[];
}

function alias(...words: string[]): string[] {
  return words.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, ""));
}

/** One canonical field list per domain — the only fields a mapping may target. */
export const CANONICAL_FIELDS: Record<ImportDomain, readonly CanonicalFieldDef[]> = {
  supplier: [
    {
      field: "name",
      label: "Supplier name",
      required: true,
      aliases: alias("Supplier Name", "Supplier", "Name", "Vendor", "Vendor Name"),
    },
    {
      field: "code",
      label: "Supplier code",
      required: false,
      aliases: alias("Code", "Supplier Code", "Vendor Code", "Account Number"),
    },
    {
      field: "contactName",
      label: "Contact name",
      required: false,
      aliases: alias("Contact", "Contact Name", "Contact Person"),
    },
    { field: "email", label: "Email", required: false, aliases: alias("Email", "Email Address") },
    {
      field: "phone",
      label: "Phone",
      required: false,
      aliases: alias("Phone", "Phone Number", "Telephone", "Tel"),
    },
    { field: "address", label: "Address", required: false, aliases: alias("Address") },
    {
      field: "paymentTerms",
      label: "Payment terms",
      required: false,
      aliases: alias("Payment Terms", "Terms"),
    },
    {
      field: "leadTimeDays",
      label: "Lead time (days)",
      required: false,
      aliases: alias("Lead Time", "Lead Time Days", "Lead Time (Days)"),
    },
  ],
  inventory_item: [
    {
      field: "name",
      label: "Item name",
      required: true,
      aliases: alias("Item Name", "Name", "Product Name", "Description", "Ingredient"),
    },
    {
      field: "sku",
      label: "SKU",
      required: false,
      aliases: alias("SKU", "Item Code", "Product Code", "Code"),
    },
    {
      field: "barcode",
      label: "Barcode",
      required: false,
      aliases: alias("Barcode", "EAN", "UPC", "Bar Code"),
    },
    { field: "brand", label: "Brand", required: false, aliases: alias("Brand", "Manufacturer") },
    {
      field: "categoryName",
      label: "Category",
      required: false,
      aliases: alias("Category", "Item Category", "Group"),
    },
    {
      field: "unitCode",
      label: "Stock unit",
      required: false,
      aliases: alias("Unit", "UOM", "Stock Unit", "Uom"),
    },
    {
      field: "packSize",
      label: "Pack size",
      required: false,
      aliases: alias("Pack Size", "Pack", "Units Per Pack"),
    },
    {
      field: "reorderPoint",
      label: "Reorder point",
      required: false,
      aliases: alias("Reorder Point", "Reorder Level", "Min Level", "Minimum"),
    },
    {
      field: "parLevel",
      label: "Par level",
      required: false,
      aliases: alias("Par Level", "Par", "Max Level"),
    },
    {
      field: "averageCost",
      label: "Unit cost",
      required: false,
      aliases: alias("Cost", "Unit Cost", "Average Cost", "Purchase Cost"),
    },
    {
      field: "openingQuantity",
      label: "Opening quantity",
      required: false,
      aliases: alias(
        "Opening Qty",
        "Opening Quantity",
        "Opening Balance",
        "Qty On Hand",
        "Stock On Hand",
        "Current Quantity",
      ),
    },
    {
      field: "openingUnit",
      label: "Opening quantity unit",
      required: false,
      aliases: alias("Opening Unit", "Opening Uom", "Count Unit"),
    },
  ],
  supplier_product: [
    {
      field: "supplierName",
      label: "Supplier",
      // Not hard-required by the validator, which accepts a supplier name
      // OR a supplier code (see the "Supplier is missing" check) — a sheet
      // that references suppliers only by their code, like Suppliers'
      // own natural key, is a legitimate, matchable source.
      required: false,
      aliases: alias("Supplier", "Supplier Name", "Vendor"),
    },
    {
      field: "supplierCode",
      label: "Supplier code (to match)",
      required: false,
      aliases: alias("Supplier Code", "Vendor Code"),
    },
    {
      field: "itemName",
      label: "Item name (to match)",
      required: true,
      aliases: alias("Item Name", "Product Name", "Name", "Description"),
    },
    {
      field: "itemSku",
      label: "Item SKU (to match)",
      required: false,
      aliases: alias("SKU", "Item Code", "Item SKU", "Inventory SKU"),
    },
    {
      field: "itemBarcode",
      label: "Item barcode (to match)",
      required: false,
      aliases: alias("Barcode", "EAN", "UPC"),
    },
    {
      field: "supplierSku",
      label: "Supplier SKU",
      required: false,
      aliases: alias("Supplier SKU", "Supplier Code", "Vendor SKU", "Catalog Number"),
    },
    {
      field: "name",
      label: "Supplier's product name",
      required: false,
      aliases: alias("Product Name", "Description", "Name"),
    },
    {
      field: "packSize",
      label: "Pack size",
      required: false,
      aliases: alias("Pack Size", "Pack", "Case Size"),
    },
    {
      field: "unitPrice",
      label: "Unit price",
      required: true,
      aliases: alias("Unit Price", "Price", "Cost", "Purchase Price", "Purchase Cost"),
    },
    {
      field: "minOrderQuantity",
      label: "Min order quantity",
      required: false,
      aliases: alias("MOQ", "Min Order", "Minimum Order Quantity"),
    },
    {
      field: "leadTimeDays",
      label: "Lead time (days)",
      required: false,
      aliases: alias("Lead Time", "Lead Time Days"),
    },
  ],
  menu_item: [
    {
      field: "name",
      label: "Dish/drink name",
      required: true,
      aliases: alias("Item Name", "Name", "Dish", "Menu Item", "Product Name"),
    },
    {
      field: "categoryName",
      label: "Menu category",
      required: false,
      aliases: alias("Category", "Category Name", "Section", "Menu Section", "Group"),
    },
    {
      field: "description",
      label: "Description",
      required: false,
      aliases: alias("Description", "Details"),
    },
    {
      field: "price",
      label: "Price",
      required: true,
      aliases: alias("Price", "Selling Price", "Menu Price"),
    },
    {
      field: "available",
      label: "Available",
      required: false,
      aliases: alias("Available", "Active", "In Stock", "On Menu"),
    },
  ],
  product_station: [
    {
      field: "menuItemName",
      label: "Dish/drink (to match)",
      required: true,
      aliases: alias("Menu Item", "Item Name", "Dish", "Name", "Product"),
    },
    {
      field: "stationCode",
      label: "Station (to match)",
      required: true,
      aliases: alias("Station", "Station Code", "Production Station", "Destination"),
    },
    {
      field: "sku",
      label: "Product SKU",
      required: false,
      aliases: alias("SKU", "Product Code", "Item Code"),
    },
    {
      field: "price",
      label: "Price",
      required: false,
      aliases: alias("Price", "Product Price"),
    },
    {
      field: "active",
      label: "Active",
      required: false,
      aliases: alias("Active", "Available"),
    },
  ],
  variant: [
    {
      field: "productMenuItemName",
      label: "Dish/drink (to match)",
      required: true,
      aliases: alias("Menu Item", "Product", "Item Name", "Dish"),
    },
    {
      field: "name",
      label: "Variant name",
      required: true,
      aliases: alias("Variant", "Variant Name", "Size", "Option"),
    },
    {
      field: "sku",
      label: "Variant SKU",
      required: false,
      aliases: alias("SKU", "Variant Code"),
    },
    {
      field: "price",
      label: "Price",
      required: true,
      aliases: alias("Price", "Variant Price"),
    },
    {
      field: "priceIsDelta",
      label: "Price is a delta",
      required: false,
      aliases: alias("Price Is Delta", "Is Delta", "Delta"),
    },
    {
      field: "active",
      label: "Active",
      required: false,
      aliases: alias("Active", "Available"),
    },
  ],
  modifier_group: [
    {
      field: "code",
      label: "Group code",
      required: true,
      aliases: alias("Code", "Group Code"),
    },
    {
      field: "name",
      label: "Group name",
      required: true,
      aliases: alias("Modifier Group", "Group Name", "Name"),
    },
    {
      field: "minSelect",
      label: "Min select",
      required: false,
      aliases: alias("Min Select", "Minimum", "Min"),
    },
    {
      field: "maxSelect",
      label: "Max select",
      required: false,
      aliases: alias("Max Select", "Maximum", "Max"),
    },
    {
      field: "required",
      label: "Required",
      required: false,
      aliases: alias("Required", "Mandatory"),
    },
    {
      field: "active",
      label: "Active",
      required: false,
      aliases: alias("Active", "Available"),
    },
  ],
  modifier: [
    {
      field: "groupCode",
      label: "Modifier group (to match)",
      required: true,
      aliases: alias("Group", "Group Code", "Modifier Group"),
    },
    {
      field: "name",
      label: "Modifier name",
      required: true,
      aliases: alias("Modifier", "Modifier Name", "Name", "Option"),
    },
    {
      field: "priceDelta",
      label: "Price delta",
      required: false,
      aliases: alias("Price", "Price Delta", "Extra Cost", "Surcharge"),
    },
    {
      field: "effect",
      label: "Stock effect",
      required: false,
      aliases: alias("Effect", "Stock Effect"),
    },
    {
      field: "ingredientName",
      label: "Ingredient (to match, if stock-affecting)",
      required: false,
      aliases: alias("Ingredient", "Ingredient Name"),
    },
    {
      field: "ingredientSku",
      label: "Ingredient SKU",
      required: false,
      aliases: alias("Ingredient SKU", "SKU"),
    },
    {
      field: "ingredientBarcode",
      label: "Ingredient barcode",
      required: false,
      aliases: alias("Ingredient Barcode", "Barcode", "EAN", "UPC"),
    },
    {
      field: "quantity",
      label: "Quantity consumed",
      required: false,
      aliases: alias("Quantity", "Qty"),
    },
    {
      field: "unitCode",
      label: "Unit",
      required: false,
      aliases: alias("Unit", "UOM", "Uom"),
    },
    {
      field: "active",
      label: "Active",
      required: false,
      aliases: alias("Active", "Available"),
    },
  ],
  product_modifier_group: [
    {
      field: "productMenuItemName",
      label: "Dish/drink (to match)",
      required: true,
      aliases: alias("Menu Item", "Product", "Item Name", "Dish"),
    },
    {
      field: "modifierGroupCode",
      label: "Modifier group (to match)",
      required: true,
      aliases: alias("Modifier Group", "Group Code", "Group"),
    },
    {
      field: "sortOrder",
      label: "Sort order",
      required: false,
      aliases: alias("Sort Order", "Order", "Position"),
    },
  ],
  recipe_component: [
    {
      field: "menuItemName",
      label: "Dish/drink (to match)",
      required: true,
      aliases: alias("Recipe", "Dish", "Menu Item", "Menu Item Name", "Item Name", "Product"),
    },
    {
      field: "ingredientName",
      label: "Ingredient name (to match)",
      // Not hard-required by the validator (stageRecipeComponentRow accepts
      // name, SKU or barcode — see the "Ingredient to link is missing" check)
      // so a SKU-only recipe sheet is a legitimate, matchable source.
      required: false,
      aliases: alias("Ingredient", "Ingredient Name", "Component"),
    },
    {
      field: "ingredientSku",
      label: "Ingredient SKU (to match)",
      required: false,
      aliases: alias("SKU", "Item Code", "Ingredient SKU"),
    },
    {
      field: "ingredientBarcode",
      label: "Ingredient barcode (to match)",
      required: false,
      aliases: alias("Barcode", "EAN", "UPC"),
    },
    {
      field: "quantity",
      label: "Quantity",
      required: true,
      aliases: alias("Quantity", "Qty", "Amount"),
    },
    { field: "unitCode", label: "Unit", required: false, aliases: alias("Unit", "UOM", "Uom") },
    {
      field: "yieldPercent",
      label: "Yield %",
      required: false,
      aliases: alias("Yield", "Yield Percent", "Yield %"),
    },
    {
      field: "notes",
      label: "Notes",
      required: false,
      aliases: alias("Notes", "Method", "Instructions"),
    },
  ],
  opening_stock: [
    {
      field: "itemName",
      label: "Item name (to match)",
      required: true,
      aliases: alias("Item Name", "Name", "Product Name"),
    },
    {
      field: "itemSku",
      label: "Item SKU (to match)",
      required: false,
      aliases: alias("SKU", "Item Code"),
    },
    {
      field: "itemBarcode",
      label: "Item barcode (to match)",
      required: false,
      aliases: alias("Barcode", "EAN", "UPC"),
    },
    {
      field: "locationName",
      label: "Storage location",
      required: false,
      aliases: alias("Location", "Store", "Storage Location"),
    },
    {
      field: "quantity",
      label: "Opening quantity",
      required: true,
      aliases: alias(
        "Quantity",
        "Opening Qty",
        "Opening Quantity",
        "Opening Balance",
        "Qty On Hand",
      ),
    },
    { field: "unitCode", label: "Unit", required: false, aliases: alias("Unit", "UOM", "Uom") },
    {
      field: "unitCost",
      label: "Unit cost",
      required: false,
      aliases: alias("Cost", "Unit Cost", "Value"),
    },
  ],
};

/** Header words that carry a domain's identity — used only to *suggest* a detected domain, never to decide it. */
const DOMAIN_SIGNAL_WORDS: Record<ImportDomain, readonly string[]> = {
  supplier: alias("Lead Time", "Payment Terms", "Vendor", "Contact Name", "Supplier Name"),
  inventory_item: alias(
    "Reorder Point",
    "Par Level",
    "Pack Size",
    "Stock Unit",
    "SKU",
    "Barcode",
    "Average Cost",
  ),
  supplier_product: alias("Supplier SKU", "MOQ", "Min Order", "Case Size", "Vendor SKU"),
  menu_item: alias("Menu Item", "Selling Price", "Menu Price", "Menu Section", "On Menu", "Dish"),
  product_station: alias("Station", "Station Code", "Production Station", "Destination"),
  variant: alias("Variant", "Variant Name", "Price Is Delta", "Size", "Option"),
  modifier_group: alias("Modifier Group", "Min Select", "Max Select", "Group Code"),
  modifier: alias("Modifier", "Price Delta", "Extra Cost", "Stock Effect"),
  product_modifier_group: alias("Modifier Group", "Group Code", "Sort Order"),
  recipe_component: alias("Recipe", "Ingredient", "Yield", "Component", "Method"),
  opening_stock: alias("Opening Qty", "Opening Quantity", "Opening Balance", "Qty On Hand"),
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface DomainGuess {
  domain: ImportDomain;
  confidence: number;
  matchedHeaders: string[];
}

/** Deterministic header heuristic — a starting suggestion, never an autonomous decision. */
export function detectDomains(headers: readonly string[]): DomainGuess[] {
  const normalized = headers.map(normalizeHeader);
  const guesses: DomainGuess[] = [];
  for (const domain of IMPORT_DOMAINS) {
    const signals = DOMAIN_SIGNAL_WORDS[domain];
    const requiredFields = CANONICAL_FIELDS[domain].filter((f) => f.required);
    const matched: string[] = [];
    let signalHits = 0;
    for (let i = 0; i < normalized.length; i++) {
      if (signals.includes(normalized[i]!)) {
        signalHits += 1;
        matched.push(headers[i]!);
      }
    }
    const requiredHit = requiredFields.every((f) => normalized.some((n) => f.aliases.includes(n)));
    if (signalHits === 0 && !requiredHit) continue;
    const confidence = Math.min(
      1,
      signalHits / Math.max(2, signals.length) + (requiredHit ? 0.3 : 0),
    );
    if (confidence > 0)
      guesses.push({ domain, confidence: Number(confidence.toFixed(2)), matchedHeaders: matched });
  }
  return guesses.sort((a, b) => b.confidence - a.confidence);
}

export interface FieldMappingEntry {
  sourceColumn: string;
  canonicalField: string | null;
  confidence: number;
  auto: boolean;
}

/** Explicit, inspectable column -> canonical field suggestion. Never applied silently — always human-reviewable/overridable. */
export function suggestFieldMapping(
  headers: readonly string[],
  domain: ImportDomain,
): FieldMappingEntry[] {
  const fields = CANONICAL_FIELDS[domain];
  const used = new Set<string>();
  return headers.map((sourceColumn) => {
    const norm = normalizeHeader(sourceColumn);
    const hit = fields.find((f) => !used.has(f.field) && f.aliases.includes(norm));
    if (hit) {
      used.add(hit.field);
      return { sourceColumn, canonicalField: hit.field, confidence: 1, auto: true };
    }
    return { sourceColumn, canonicalField: null, confidence: 0, auto: false };
  });
}
