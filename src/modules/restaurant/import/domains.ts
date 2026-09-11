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
  "menu",
  "category",
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
  menu: "Menus",
  category: "Categories",
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
 * by an earlier one. `menu` and `category` must land before `menu_item`
 * (which resolves a row's Menu Code / Category Code against them),
 * `product_station` must land before `variant`, `product_modifier_group`
 * and `recipe_component` (all three may resolve a row's Item Code against
 * the product bridge row `product_station` creates), `modifier`/
 * `product_modifier_group` must land after `modifier_group`.
 */
export const IMPORT_DOMAIN_COMMIT_ORDER: readonly ImportDomain[] = [
  "supplier",
  "inventory_item",
  "supplier_product",
  "menu",
  "category",
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
      aliases: alias(
        "Item Name",
        "Name",
        "Product Name",
        "Product",
        "Product Description",
        "Description",
        "Ingredient",
        "Material",
        "Article",
        "Stock Item",
      ),
    },
    {
      field: "sku",
      label: "SKU",
      required: false,
      aliases: alias("SKU", "Item Code", "Product Code", "Code", "Stock Code", "Article Number"),
    },
    {
      field: "barcode",
      label: "Barcode",
      required: false,
      aliases: alias("Barcode", "EAN", "UPC", "Bar Code", "GTIN"),
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
      aliases: alias("Unit", "UOM", "Stock Unit", "Uom", "Unit Of Measure", "Measure"),
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
      aliases: alias(
        "Cost",
        "Unit Cost",
        "Average Cost",
        "Purchase Cost",
        "Buy Price",
        "Buying Price",
        "Rate",
      ),
    },
    {
      field: "currency",
      label: "Currency (if not the property's own)",
      required: false,
      aliases: alias("Currency", "Ccy", "Curr"),
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
        "Balance",
        "On Hand",
        "Physical Count",
      ),
    },
    {
      field: "openingUnit",
      label: "Opening quantity unit",
      required: false,
      aliases: alias("Opening Unit", "Opening Uom", "Count Unit"),
    },
    {
      field: "purchaseUnitCode",
      label: "Purchase unit (how it's bought)",
      required: false,
      aliases: alias("Purchase Unit", "Buy Unit", "Order Unit"),
    },
    {
      field: "consumptionUnitCode",
      label: "Consumption unit (how it's used)",
      required: false,
      aliases: alias("Consumption Unit", "Recipe Unit", "Usage Unit"),
    },
    {
      field: "contentPerStockUnit",
      // The quantity contained inside one stock unit — e.g. a 750ml bottle
      // (Stock Unit "BTL") has a Content per Stock Unit of 750. Distinct
      // from Pack Size (how many stock units are in one purchase unit — 12
      // bottles in a carton): this is what's *inside* one bottle, not how
      // many bottles are in a case. Maps to restaurant_inventory_items'
      // content_per_stock_unit column — itself distinct from serving_size,
      // which is the Bar Pour Setup's own "how much per glass" and must
      // never be conflated with the bottle's own content (see bar/pour.ts).
      label: "Content per stock unit",
      required: false,
      aliases: alias("Content Per Stock Unit", "Contents", "Fill Size"),
    },
    {
      field: "contentUnitCode",
      label: "Content unit",
      required: false,
      aliases: alias("Content Unit", "Fill Unit"),
    },
    {
      field: "isBeverage",
      label: "Is beverage",
      required: false,
      aliases: alias("Is Beverage", "Beverage"),
    },
    {
      field: "shelfLifeDays",
      label: "Shelf life (days)",
      required: false,
      aliases: alias("Shelf Life", "Shelf Life Days", "Shelf Life (Days)"),
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
      aliases: alias("Product Name", "Description", "Name", "Supplier Product Name"),
    },
    {
      field: "unitCode",
      label: "Purchase unit (how the supplier sells it)",
      required: false,
      aliases: alias("Purchase Unit", "Unit", "UOM"),
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
      aliases: alias(
        "Unit Price",
        "Price",
        "Cost",
        "Purchase Price",
        "Purchase Cost",
        "Buy Price",
        "Buying Price",
        "Rate",
      ),
    },
    {
      field: "currency",
      label: "Currency (if not the property's own)",
      required: false,
      aliases: alias("Currency", "Ccy", "Curr"),
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
  menu: [
    {
      field: "code",
      label: "Menu code",
      required: true,
      aliases: alias("Menu Code", "Code"),
    },
    {
      field: "name",
      label: "Menu name",
      required: true,
      aliases: alias("Menu Name", "Name"),
    },
    {
      field: "serviceType",
      label: "Type",
      required: false,
      aliases: alias("Type", "Service Type"),
    },
    {
      field: "status",
      label: "Status",
      required: false,
      aliases: alias("Status"),
    },
    {
      field: "currency",
      label: "Currency (if not the property's own)",
      required: false,
      aliases: alias("Currency", "Ccy", "Curr"),
    },
    {
      field: "description",
      label: "Description",
      required: false,
      aliases: alias("Description", "Details"),
    },
  ],
  category: [
    {
      field: "menuCode",
      // Categories are shared tenant-wide in the data model (there is no
      // menu_id column on restaurant_categories) — this column cross-checks
      // that the category is actually declared for a menu that exists, but
      // it does not scope the created category row to that menu. See the
      // "declared for a different menu" advisory in stage.ts.
      label: "Menu code (to cross-check)",
      required: false,
      aliases: alias("Menu Code", "Menu"),
    },
    {
      field: "code",
      label: "Category code",
      required: true,
      aliases: alias("Category Code", "Code"),
    },
    {
      field: "name",
      label: "Category name",
      required: true,
      aliases: alias("Category Name", "Name", "Category"),
    },
    {
      field: "sortOrder",
      label: "Sort order",
      required: false,
      aliases: alias("Sort Order", "Order", "Position"),
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
      field: "menuCode",
      label: "Menu code (to match)",
      required: false,
      aliases: alias("Menu Code", "Menu"),
    },
    {
      field: "categoryCode",
      label: "Category code (to match)",
      required: false,
      aliases: alias("Category Code"),
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
      aliases: alias(
        "Price",
        "Selling Price",
        "Sale Price",
        "Sell Price",
        "Menu Price",
        "Retail Price",
      ),
    },
    {
      field: "currency",
      label: "Currency (if not the property's own)",
      required: false,
      aliases: alias("Currency", "Ccy", "Curr"),
    },
    {
      field: "available",
      label: "Available",
      required: false,
      aliases: alias("Available", "Active", "In Stock", "On Menu"),
    },
    {
      field: "sortOrder",
      label: "Sort order",
      required: false,
      aliases: alias("Sort Order", "Order", "Position"),
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
      field: "itemCode",
      // Preferred over productMenuItemName when present — an exact code
      // match against the product bridge row's own SKU, never fuzzy. Not
      // hard-required here because a name-only source sheet (no codes at
      // all) is still legitimate — see the "Dish/drink to match is missing"
      // check in stageVariantRow, which requires at least one of the two.
      label: "Item code (to match)",
      required: false,
      aliases: alias("Item Code", "Product Code", "SKU"),
    },
    {
      field: "productMenuItemName",
      label: "Dish/drink (to match)",
      required: false,
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
      aliases: alias("Price", "Variant Price", "Price Delta"),
    },
    {
      field: "priceIsDelta",
      label: "Price is a delta",
      required: false,
      aliases: alias("Price Is Delta", "Is Delta", "Delta", "Pricing Method"),
    },
    {
      field: "active",
      label: "Active",
      required: false,
      aliases: alias("Active", "Available"),
    },
    {
      field: "sortOrder",
      label: "Sort order",
      required: false,
      aliases: alias("Sort Order", "Order", "Position"),
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
      aliases: alias("Min Select", "Minimum", "Min", "Minimum Selections"),
    },
    {
      field: "maxSelect",
      label: "Max select",
      required: false,
      aliases: alias("Max Select", "Maximum", "Max", "Maximum Selections"),
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
    {
      field: "sortOrder",
      label: "Sort order",
      required: false,
      aliases: alias("Sort Order", "Order", "Position"),
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
      aliases: alias("Ingredient SKU", "SKU", "Inventory SKU"),
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
    {
      field: "sortOrder",
      label: "Sort order",
      required: false,
      aliases: alias("Sort Order", "Order", "Position"),
    },
  ],
  product_modifier_group: [
    {
      field: "itemCode",
      label: "Item code (to match)",
      required: false,
      aliases: alias("Item Code", "Product Code", "SKU"),
    },
    {
      field: "productMenuItemName",
      label: "Dish/drink (to match)",
      required: false,
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
      field: "itemCode",
      // Resolved via the product bridge row's own SKU (restaurant_products),
      // which is where recipe_component's menu_item_id actually comes from
      // once a code is given — see stageRecipeComponentRow. Preferred over
      // menuItemName when present; not hard-required since a name-only
      // source is still legitimate (see the "Dish/drink to match is
      // missing" check, which requires at least one of the two).
      label: "Item code (to match)",
      required: false,
      aliases: alias("Item Code", "Product Code"),
    },
    {
      field: "menuItemName",
      label: "Dish/drink (to match)",
      required: false,
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
    {
      field: "currency",
      label: "Currency (if not the property's own)",
      required: false,
      aliases: alias("Currency", "Ccy", "Curr"),
    },
  ],
};

/**
 * Every canonical field alias across every domain, flattened — the one
 * semantic signal a header-row finder needs to tell a real header row
 * ("Item Name", "SKU", "Qty") apart from a title/notes row above it, without
 * that finder needing to know what a "domain" is. Not a classifier by
 * itself: a row scoring high here is still just *evidence* of being a
 * header row, exactly like a signal word is only ever evidence of a domain.
 */
export const ALL_CANONICAL_ALIASES: ReadonlySet<string> = new Set(
  Object.values(CANONICAL_FIELDS).flatMap((fields) => fields.flatMap((f) => f.aliases)),
);

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
  menu: alias("Menu Code", "Menu Name", "Service Type"),
  category: alias("Category Code", "Category Name", "Sort Order"),
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
  /** Omitted for the deterministic alias/signal-word heuristic; "ai" for a validated AI-assist suggestion (see import/ai-assist.ts) appended only when the heuristic alone was weak or empty. Either way this is still just a suggestion — a human still confirms it before anything is staged. */
  source?: "ai";
}

/**
 * Deterministic header heuristic — a starting suggestion, never an
 * autonomous decision. Evidence comes from two places, combined: a small
 * hand-picked list of especially identity-establishing words per domain
 * (DOMAIN_SIGNAL_WORDS, surfaced back to the caller as matchedHeaders — the
 * "why" a reviewer sees), and the SAME alias table suggestFieldMapping
 * itself uses for every canonical field on the domain, not only the curated
 * subset. That second signal exists so a sheet a human would obviously call
 * "inventory" — because most of its columns genuinely map to inventory
 * fields — still registers real evidence even when none of its headers
 * happen to be one of the specific words DOMAIN_SIGNAL_WORDS lists; keeping
 * DOMAIN_SIGNAL_WORDS in sync with every alias ever added to CANONICAL_
 * FIELDS would otherwise be a second, easily-forgotten place to update.
 */
export function detectDomains(headers: readonly string[]): DomainGuess[] {
  const normalized = headers.map(normalizeHeader);
  const guesses: DomainGuess[] = [];
  for (const domain of IMPORT_DOMAINS) {
    const signals = DOMAIN_SIGNAL_WORDS[domain];
    const fields = CANONICAL_FIELDS[domain];
    const requiredFields = fields.filter((f) => f.required);
    const matched: string[] = [];
    let signalHits = 0;
    const fieldsCovered = new Set<string>();
    for (let i = 0; i < normalized.length; i++) {
      if (signals.includes(normalized[i]!)) {
        signalHits += 1;
        matched.push(headers[i]!);
      }
      const hitField = fields.find((f) => f.aliases.includes(normalized[i]!));
      if (hitField) fieldsCovered.add(hitField.field);
    }
    const requiredHit = requiredFields.every((f) => normalized.some((n) => f.aliases.includes(n)));
    // A single incidental alias hit (e.g. a lone "Notes" column) is too weak
    // to trust as its own evidence — that is exactly the class of mistake
    // that pre-selects the wrong domain in the mapping UI for an otherwise
    // irrelevant sheet. Two or more distinct fields covered is a genuinely
    // different signal: several of this sheet's columns really do mean
    // something to this domain.
    const genuineFieldCoverage = fieldsCovered.size >= 2;
    if (signalHits === 0 && !requiredHit && !genuineFieldCoverage) continue;
    const confidence = Math.min(
      1,
      signalHits / Math.max(2, signals.length) +
        (requiredHit ? 0.3 : 0) +
        (genuineFieldCoverage ? Math.min(0.4, fieldsCovered.size * 0.1) : 0),
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
