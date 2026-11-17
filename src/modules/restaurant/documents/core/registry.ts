/**
 * Central document-type registry. Browser-safe.
 *
 * The registry declares *what documents exist*, who may see them, which
 * formats they support and which operational record they belong to. It is the
 * single list the Document Centre, the workflow buttons and the RPC surface
 * all read from, so a document can never exist in one place and not another.
 */
import type { RestaurantCapability } from "../../core/permissions";
import type { DocFormat } from "./types";

export const DOCUMENT_GROUPS = ["procurement", "inventory", "products", "sales", "operations"] as const;
export type DocumentGroup = (typeof DOCUMENT_GROUPS)[number];

export const DOCUMENT_TYPE_IDS = [
  // Procurement
  "purchase_request",
  "purchase_order",
  "supplier_confirmation",
  "goods_receipt",
  "supplier_invoice",
  "variance_report",
  "supplier_statement",
  // Inventory
  "requisition",
  "stock_transfer",
  "stocktake_sheet",
  "waste_report",
  "inventory_valuation",
  "stock_ledger",
  // Products
  "recipe_sheet",
  "menu_price_list",
  // Sales
  "customer_receipt",
  "sales_report",
  "payment_reconciliation",
  // Operations
  "daily_closing",
] as const;
export type DocumentTypeId = (typeof DOCUMENT_TYPE_IDS)[number];

export interface DocumentTypeDefinition {
  id: DocumentTypeId;
  label: string;
  group: DocumentGroup;
  /** "document" renders a printable page; "export" produces a dataset. */
  kind: "document" | "export";
  /** Capability required to open or export it. */
  capability: RestaurantCapability;
  /** Server-owned number prefix, when the type carries a document number. */
  numberPrefix?: string;
  formats: readonly DocFormat[];
  /** Underlying operational table, used for traceability and search. */
  sourceTable?: string;
  /** Where the operational record lives in the app. */
  workflowRoute?: string;
  description: string;
  /** Whether the rendered output is frozen at issuance. */
  immutable: boolean;
}

const DOC_FORMATS: readonly DocFormat[] = ["print", "pdf", "csv", "xlsx", "json"];
const EXPORT_FORMATS: readonly DocFormat[] = ["csv", "xlsx", "json"];

export const DOCUMENT_TYPES: Record<DocumentTypeId, DocumentTypeDefinition> = {
  purchase_request: {
    id: "purchase_request",
    label: "Purchase Request",
    group: "procurement",
    kind: "document",
    capability: "purchasing.manage",
    numberPrefix: "PR",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_purchase_requests",
    workflowRoute: "/admin/restaurant/procurement",
    description: "Internal request that starts the procurement chain.",
    immutable: false,
  },
  purchase_order: {
    id: "purchase_order",
    label: "Purchase Order",
    group: "procurement",
    kind: "document",
    capability: "purchasing.manage",
    numberPrefix: "PO",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_purchase_orders",
    workflowRoute: "/admin/restaurant/purchasing",
    description: "Supplier-facing order with agreed quantities and prices.",
    immutable: true,
  },
  supplier_confirmation: {
    id: "supplier_confirmation",
    label: "Supplier Confirmation",
    group: "procurement",
    kind: "document",
    capability: "purchasing.manage",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_supplier_confirmations",
    workflowRoute: "/admin/restaurant/purchasing",
    description: "What the supplier committed to, against what was ordered.",
    immutable: true,
  },
  goods_receipt: {
    id: "goods_receipt",
    label: "Goods Receipt (GRN)",
    group: "procurement",
    kind: "document",
    capability: "receiving.manage",
    numberPrefix: "GRN",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_goods_receipts",
    workflowRoute: "/admin/restaurant/procurement",
    description: "Ordered vs delivered vs accepted vs rejected, as received.",
    immutable: true,
  },
  supplier_invoice: {
    id: "supplier_invoice",
    label: "Supplier Invoice",
    group: "procurement",
    kind: "document",
    capability: "invoice.manage",
    numberPrefix: "SI",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_supplier_invoices",
    workflowRoute: "/admin/restaurant/procurement",
    description: "Recorded supplier invoice with three-way match status.",
    immutable: true,
  },
  variance_report: {
    id: "variance_report",
    label: "Variance Report",
    group: "procurement",
    kind: "document",
    capability: "variance.manage",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_procurement_variances",
    workflowRoute: "/admin/restaurant/procurement",
    description: "Quantity, price, quality and invoice variances for review.",
    immutable: false,
  },
  supplier_statement: {
    id: "supplier_statement",
    label: "Supplier Statement",
    group: "procurement",
    kind: "document",
    capability: "invoice.manage",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_suppliers",
    workflowRoute: "/admin/restaurant/suppliers",
    description: "Purchases and invoices per supplier over a period.",
    immutable: false,
  },
  requisition: {
    id: "requisition",
    label: "Requisition Note",
    group: "inventory",
    kind: "document",
    capability: "requisition.create",
    numberPrefix: "REQ",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_requisitions",
    workflowRoute: "/admin/restaurant/requisitions",
    description: "Department request, approval, issue and receipt of stock from a store.",
    immutable: false,
  },
  stock_transfer: {
    id: "stock_transfer",
    label: "Stock Transfer Note",
    group: "inventory",
    kind: "document",
    capability: "transfer.manage",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_stock_transfers",
    workflowRoute: "/admin/restaurant/inventory-control",
    description: "Movement of stock between locations.",
    immutable: true,
  },
  stocktake_sheet: {
    id: "stocktake_sheet",
    label: "Stocktake Sheet",
    group: "inventory",
    kind: "document",
    capability: "stocktake.manage",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_stocktakes",
    workflowRoute: "/admin/restaurant/inventory-control",
    description: "System vs counted quantities with variance value.",
    immutable: false,
  },
  waste_report: {
    id: "waste_report",
    label: "Waste Report",
    group: "inventory",
    kind: "export",
    capability: "waste.record",
    formats: EXPORT_FORMATS,
    sourceTable: "restaurant_stock_movements",
    workflowRoute: "/admin/restaurant/inventory-control",
    description: "Wastage movements with reason, value and actor.",
    immutable: false,
  },
  inventory_valuation: {
    id: "inventory_valuation",
    label: "Inventory Valuation",
    group: "inventory",
    kind: "export",
    capability: "inventory.manage",
    formats: EXPORT_FORMATS,
    sourceTable: "restaurant_inventory_items",
    workflowRoute: "/admin/restaurant/inventory-control",
    description: "Stock positions, availability and value by location.",
    immutable: false,
  },
  stock_ledger: {
    id: "stock_ledger",
    label: "Stock Ledger",
    group: "inventory",
    kind: "export",
    capability: "inventory.manage",
    formats: EXPORT_FORMATS,
    sourceTable: "restaurant_stock_movements",
    workflowRoute: "/admin/restaurant/stock",
    description: "Authoritative movement ledger with running balance.",
    immutable: false,
  },
  recipe_sheet: {
    id: "recipe_sheet",
    label: "Recipe Sheet",
    group: "products",
    kind: "document",
    capability: "recipe.manage",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_recipes",
    workflowRoute: "/admin/restaurant/products",
    description: "Versioned recipe with exploded sub-recipes and cost.",
    immutable: false,
  },
  menu_price_list: {
    id: "menu_price_list",
    label: "Menu / Price List",
    group: "products",
    kind: "document",
    capability: "pricing.manage",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_prices",
    workflowRoute: "/admin/restaurant/pricing",
    description: "Menu pricing resolved through the commercial engine.",
    immutable: false,
  },
  customer_receipt: {
    id: "customer_receipt",
    label: "Customer Receipt",
    group: "sales",
    kind: "document",
    capability: "sales.manage",
    numberPrefix: "REC",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_receipts",
    workflowRoute: "/admin/restaurant/orders",
    description: "Immutable fiscal receipt issued at payment.",
    immutable: true,
  },
  sales_report: {
    id: "sales_report",
    label: "Sales Report",
    group: "sales",
    kind: "export",
    capability: "sales.manage",
    formats: EXPORT_FORMATS,
    sourceTable: "restaurant_order_items",
    workflowRoute: "/admin/restaurant/orders",
    description: "Line-level sales with gross, discount, tax, charge and net.",
    immutable: false,
  },
  payment_reconciliation: {
    id: "payment_reconciliation",
    label: "Payment Reconciliation",
    group: "sales",
    kind: "export",
    capability: "profitability.manage",
    formats: EXPORT_FORMATS,
    sourceTable: "restaurant_payments",
    workflowRoute: "/admin/restaurant/orders",
    description: "Expected vs received by payment method for till reconciliation.",
    immutable: false,
  },
  daily_closing: {
    id: "daily_closing",
    label: "Daily Closing Report",
    group: "operations",
    kind: "document",
    capability: "profitability.manage",
    formats: DOC_FORMATS,
    sourceTable: "restaurant_orders",
    workflowRoute: "/admin/restaurant",
    description: "End-of-day trading, tender mix and unresolved exceptions.",
    immutable: false,
  },
};

export const DOCUMENT_TYPE_LIST: DocumentTypeDefinition[] = DOCUMENT_TYPE_IDS.map((id) => DOCUMENT_TYPES[id]);

export function documentType(id: string): DocumentTypeDefinition | undefined {
  return (DOCUMENT_TYPES as Record<string, DocumentTypeDefinition>)[id];
}

/** Number prefixes the global document search understands, e.g. `PO-2026-000142`. */
export const NUMBER_PREFIX_TO_TYPE: Record<string, DocumentTypeId> = DOCUMENT_TYPE_IDS.reduce(
  (acc, id) => {
    const prefix = DOCUMENT_TYPES[id].numberPrefix;
    if (prefix) acc[prefix] = id;
    return acc;
  },
  {} as Record<string, DocumentTypeId>,
);

export const DOCUMENT_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "ISSUED",
  "POSTED",
  "CANCELLED",
] as const;