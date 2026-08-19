/**
 * Restaurant & Bar OS — shared contracts.
 * Browser-safe: types + zod schemas only.
 */
import { z } from "zod";

export const RESTAURANT_ROLES = [
  "owner",
  "general_manager",
  "restaurant_manager",
  "chef",
  "kitchen_manager",
  "bartender",
  "inventory_manager",
  "purchasing_officer",
  "accountant",
  "viewer",
] as const;
export type RestaurantRole = (typeof RESTAURANT_ROLES)[number];

export const RESTAURANT_LOCATION_TYPES = [
  "restaurant",
  "bar",
  "kitchen",
  "banquet",
  "room_service",
  "cafe",
  "store",
] as const;
export type RestaurantLocationType = (typeof RESTAURANT_LOCATION_TYPES)[number];

export const MENU_STATUSES = ["draft", "published", "archived"] as const;
export type MenuStatus = (typeof MENU_STATUSES)[number];

export const PO_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "partially_received",
  "received",
  "cancelled",
] as const;
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

export const INVENTORY_ITEM_TYPES = ["ingredient", "beverage", "consumable", "packaging"] as const;
export type InventoryItemType = (typeof INVENTORY_ITEM_TYPES)[number];

const uuid = z.string().uuid();

/** Every read/write is scoped by this envelope. Property/location narrow it. */
export const tenantScopeSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
});
export type TenantScope = z.infer<typeof tenantScopeSchema>;

/* ---------------- Tenancy ---------------- */

export interface RestaurantTenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  settings: RestaurantTenantSettings;
}

/** Configurable per tenant — never hard-coded in the app. */
export interface RestaurantTenantSettings {
  tax?: { vat_percent?: number; inclusive?: boolean; label?: string };
  service_charge_percent?: number;
  default_currency?: string;
}

export interface RestaurantProperty {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  status: string;
}

export interface RestaurantLocation {
  id: string;
  tenant_id: string;
  property_id: string;
  slug: string;
  name: string;
  location_type: string;
  status: string;
}

export interface RestaurantSubscription {
  plan: string;
  status: string;
  seats: number;
  features: Record<string, boolean>;
  trial_ends_at: string | null;
  current_period_end: string | null;
}

export interface RestaurantWorkspace {
  tenant: RestaurantTenant | null;
  tenants: Array<Pick<RestaurantTenant, "id" | "slug" | "name">>;
  properties: RestaurantProperty[];
  locations: RestaurantLocation[];
  subscription: RestaurantSubscription | null;
  /** Restaurant roles the caller holds in the active tenant. */
  roles: RestaurantRole[];
  /** True when the caller is a host-platform owner/admin/manager. */
  platformAdmin: boolean;
}

export const workspaceSchema = z.object({ tenantId: uuid.optional() });

/* ---------------- Menu ---------------- */

export const listMenusSchema = tenantScopeSchema.extend({
  status: z.enum(MENU_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

export const upsertMenuSchema = tenantScopeSchema.extend({
  id: uuid.optional(),
  name: z.string().min(2).max(160),
  slug: z.string().min(2).max(120).regex(/^[a-z0-9-]+$/),
  version: z.number().int().min(1).default(1),
  status: z.enum(MENU_STATUSES).default("draft"),
  currency: z.string().min(3).max(3).default("TZS"),
  description: z.string().max(2000).optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
});
export type UpsertMenuInput = z.infer<typeof upsertMenuSchema>;

export const listMenuItemsSchema = z.object({
  tenantId: uuid,
  menuId: uuid.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export const upsertMenuItemSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  menuId: uuid,
  categoryId: uuid.optional(),
  name: z.string().min(2).max(160),
  slug: z.string().min(2).max(120).regex(/^[a-z0-9-]+$/),
  description: z.string().max(2000).optional(),
  price: z.number().min(0).default(0),
  currency: z.string().min(3).max(3).default("TZS"),
  available: z.boolean().default(true),
  tags: z.array(z.string().max(40)).default([]),
  allergens: z.array(z.string().max(40)).default([]),
  sortOrder: z.number().int().min(0).default(0),
});
export type UpsertMenuItemInput = z.infer<typeof upsertMenuItemSchema>;

export const listCategoriesSchema = z.object({
  tenantId: uuid,
  kind: z.string().max(40).default("menu"),
});

/* ---------------- Inventory ---------------- */

export const listInventorySchema = tenantScopeSchema.extend({
  itemType: z.enum(INVENTORY_ITEM_TYPES).optional(),
  lowOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(200),
});

export const upsertInventoryItemSchema = tenantScopeSchema.extend({
  id: uuid.optional(),
  categoryId: uuid.optional(),
  unitId: uuid.optional(),
  sku: z.string().max(60).optional(),
  name: z.string().min(2).max(160),
  itemType: z.enum(INVENTORY_ITEM_TYPES).default("ingredient"),
  currentQuantity: z.number().default(0),
  parLevel: z.number().optional(),
  reorderPoint: z.number().optional(),
  averageCost: z.number().min(0).default(0),
  currency: z.string().min(3).max(3).default("TZS"),
  /** Extended setup fields — existing columns on restaurant_inventory_items. */
  trackBatches: z.boolean().default(false),
  allowNegative: z.boolean().default(false),
  purchaseUnitId: uuid.optional(),
  consumptionUnitId: uuid.optional(),
  packSize: z.number().min(0).optional(),
  shelfLifeDays: z.number().int().min(0).max(3650).optional(),
  /** Beverage / bar configuration — existing columns on restaurant_inventory_items. */
  isBeverage: z.boolean().optional(),
  /** Standard pour/serving magnitude, expressed in `servingUnitId`. */
  servingSize: z.number().min(0).optional(),
  servingUnitId: uuid.optional(),
});
export type UpsertInventoryItemInput = z.infer<typeof upsertInventoryItemSchema>;

/* ---------------- Suppliers ---------------- */

export const listSuppliersSchema = z.object({
  tenantId: uuid,
  limit: z.number().int().min(1).max(300).default(100),
});

export const upsertSupplierSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  name: z.string().min(2).max(160),
  code: z.string().max(40).optional(),
  contactName: z.string().max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  address: z.string().max(400).optional(),
  paymentTerms: z.string().max(120).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  status: z.string().max(30).default("active"),
  /** Extended profile — persisted into restaurant_suppliers.metadata (no new columns). */
  tradingName: z.string().max(160).optional(),
  taxNumber: z.string().max(80).optional(),
  billingAddress: z.string().max(400).optional(),
  deliveryAddress: z.string().max(400).optional(),
  deliveryDays: z.array(z.string().max(20)).default([]),
  minimumOrderValue: z.number().min(0).optional(),
  preferred: z.boolean().default(false),
  suppliedCategoryIds: z.array(uuid).default([]),
});
export type UpsertSupplierInput = z.infer<typeof upsertSupplierSchema>;

/* ---------------- Purchasing ---------------- */

export const listPurchaseOrdersSchema = tenantScopeSchema.extend({
  status: z.enum(PO_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const createPurchaseOrderSchema = tenantScopeSchema.extend({
  supplierId: uuid.optional(),
  reference: z.string().max(60).optional(),
  expectedAt: z.string().optional(),
  currency: z.string().min(3).max(3).default("TZS"),
  notes: z.string().max(2000).optional(),
  /**
   * A purchase order raised without a requisition is an exception, not a
   * shortcut: the reason for bypassing the request stage is mandatory and is
   * written to the audit trail.
   */
  directReason: z.string().min(10).max(500),
  lines: z
    .array(
      z.object({
        inventoryItemId: uuid.optional(),
        supplierProductId: uuid.optional(),
        unitId: uuid.optional(),
        description: z.string().min(1).max(200),
        quantity: z.number().min(0),
        unitPrice: z.number().min(0),
      }),
    )
    .default([]),
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

export const transitionPurchaseOrderSchema = z.object({
  tenantId: uuid,
  id: uuid,
  /**
   * Only user-driven statuses are accepted. `partially_received` / `received`
   * are derived by the receiving service from posted stock.
   */
  status: z.enum(["submitted", "approved", "cancelled"]),
  reason: z.string().max(500).optional(),
});

/* ---------------- Costing ---------------- */

export const recipeSchema = z.object({ tenantId: uuid, menuItemId: uuid });

export const upsertRecipeComponentSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  menuItemId: uuid,
  inventoryItemId: uuid.optional(),
  unitId: uuid.optional(),
  quantity: z.number().min(0),
  yieldPercent: z.number().min(1).max(100).default(100),
  notes: z.string().max(500).optional(),
});

export const computeRecipeCostSchema = z.object({
  tenantId: uuid,
  menuItemId: uuid,
  targetMargin: z.number().min(0).max(95).optional(),
  overheadCost: z.number().min(0).default(0),
});
export type ComputeRecipeCostInput = z.infer<typeof computeRecipeCostSchema>;

/* ================= Phase 2 — Operations Engine ================= */

export const ORDER_STATUSES = ["open", "sent", "served", "closed", "cancelled", "voided"] as const;
export type RestaurantOrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TYPES = ["dine_in", "bar", "takeaway", "room_service", "delivery", "banquet"] as const;
export type RestaurantOrderType = (typeof ORDER_TYPES)[number];

export const PAYMENT_STATES = [
  "unpaid",
  "partially_paid",
  "paid",
  "refunded",
  "comped",
  "room_charged",
] as const;
export type RestaurantPaymentState = (typeof PAYMENT_STATES)[number];

export const TABLE_STATUSES = ["available", "occupied", "reserved", "cleaning", "out_of_service"] as const;
export type RestaurantTableStatus = (typeof TABLE_STATUSES)[number];

export const TICKET_STATUSES = ["queued", "preparing", "ready", "served", "cancelled"] as const;
export type RestaurantTicketStatus = (typeof TICKET_STATUSES)[number];

export const STOCK_MOVEMENT_TYPES = [
  "opening_balance",
  "purchase_receipt",
  "consumption",
  "wastage",
  "transfer_in",
  "transfer_out",
  "adjustment",
  "adjustment_in",
  "adjustment_out",
  "production",
  "reversal",
  "return_to_supplier",
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/* ---------------- Sales & POS ---------------- */

export const listServicePeriodsSchema = tenantScopeSchema;

export const upsertServicePeriodSchema = tenantScopeSchema.extend({
  id: uuid.optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(2).max(120),
  startTime: z.string().max(8).default("00:00"),
  endTime: z.string().max(8).default("23:59"),
  sortOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

export const listTablesSchema = tenantScopeSchema;

export const upsertTableSchema = tenantScopeSchema.extend({
  id: uuid.optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  zone: z.string().max(60).optional(),
  seats: z.number().int().min(1).max(60).default(2),
  status: z.enum(TABLE_STATUSES).default("available"),
  active: z.boolean().default(true),
});

export const orderLineSchema = z.object({
  menuItemId: uuid.optional(),
  stationId: uuid.optional(),
  description: z.string().min(1).max(200),
  quantity: z.number().min(0.001).default(1),
  unitPrice: z.number().min(0).default(0),
  discount: z.number().min(0).default(0),
  taxAmount: z.number().min(0).default(0),
  course: z.string().max(40).optional(),
  notes: z.string().max(500).optional(),
});
export type OrderLineInput = z.infer<typeof orderLineSchema>;

export const listOrdersSchema = tenantScopeSchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  paymentState: z.enum(PAYMENT_STATES).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const createOrderSchema = tenantScopeSchema.extend({
  tableId: uuid.optional(),
  servicePeriodId: uuid.optional(),
  orderType: z.enum(ORDER_TYPES).default("dine_in"),
  guestCount: z.number().int().min(0).max(500).default(1),
  guestName: z.string().max(160).optional(),
  bookingId: uuid.optional(),
  currency: z.string().min(3).max(3).default("TZS"),
  source: z.string().max(60).default("manual"),
  externalRef: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(orderLineSchema).default([]),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const addOrderItemsSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  lines: z.array(orderLineSchema).min(1),
});
export type AddOrderItemsInput = z.infer<typeof addOrderItemsSchema>;

export const getOrderSchema = z.object({ tenantId: uuid, orderId: uuid });

export const transitionOrderSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  status: z.enum(ORDER_STATUSES),
  reason: z.string().max(500).optional(),
});
export type TransitionOrderInput = z.infer<typeof transitionOrderSchema>;

export const recordPaymentSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  method: z.string().min(2).max(40).default("cash"),
  amount: z.number().min(0),
  tendered: z.number().min(0).optional(),
  reference: z.string().max(120).optional(),
  bookingId: uuid.optional(),
  state: z.enum(PAYMENT_STATES).default("paid"),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/* ---------------- Kitchen operations ---------------- */

export const listStationsSchema = tenantScopeSchema;

export const upsertStationSchema = tenantScopeSchema.extend({
  id: uuid.optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(2).max(120),
  stationType: z.string().max(40).default("kitchen"),
  targetPrepMinutes: z.number().int().min(1).max(240).default(15),
  sortOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

export const listTicketsSchema = tenantScopeSchema.extend({
  status: z.enum(TICKET_STATUSES).optional(),
  stationId: uuid.optional(),
  openOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(100),
});

export const fireOrderSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  /** Only fire these order items. Empty = every un-fired item. */
  orderItemIds: z.array(uuid).default([]),
  priority: z.number().int().min(0).max(5).default(0),
});
export type FireOrderInput = z.infer<typeof fireOrderSchema>;

export const advanceTicketSchema = z.object({
  tenantId: uuid,
  ticketId: uuid,
  status: z.enum(TICKET_STATUSES),
  notes: z.string().max(500).optional(),
});
export type AdvanceTicketInput = z.infer<typeof advanceTicketSchema>;

/* ---------------- Inventory movement engine ---------------- */

export const listMovementsSchema = tenantScopeSchema.extend({
  inventoryItemId: uuid.optional(),
  movementType: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export const recordMovementSchema = tenantScopeSchema.extend({
  inventoryItemId: uuid,
  unitId: uuid.optional(),
  movementType: z.enum(STOCK_MOVEMENT_TYPES),
  /** Magnitude. Direction is derived from the movement type. */
  quantity: z.number().min(0),
  unitCost: z.number().min(0).optional(),
  currency: z.string().min(3).max(3).default("TZS"),
  reason: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
  referenceType: z.string().max(60).optional(),
  referenceId: uuid.optional(),
  occurredAt: z.string().optional(),
  dedupeKey: z.string().max(200).optional(),
});
export type RecordMovementInput = z.infer<typeof recordMovementSchema>;

export const transferStockSchema = tenantScopeSchema.extend({
  inventoryItemId: uuid,
  destinationLocationId: uuid,
  quantity: z.number().min(0.0001),
  unitId: uuid.optional(),
  reason: z.string().max(200).optional(),
});
export type TransferStockInput = z.infer<typeof transferStockSchema>;

/* ---------------- Cost intelligence ---------------- */

export const profitabilitySchema = tenantScopeSchema.extend({
  from: z.string(),
  to: z.string(),
  persist: z.boolean().default(true),
  limit: z.number().int().min(1).max(300).default(100),
});
export type ProfitabilityInput = z.infer<typeof profitabilitySchema>;

export const listProfitabilitySchema = tenantScopeSchema.extend({
  limit: z.number().int().min(1).max(300).default(100),
});

/* ---------------- Tenant membership ---------------- */

export const listMembersSchema = z.object({ tenantId: uuid });

export const upsertMemberSchema = z.object({
  tenantId: uuid,
  userId: uuid,
  role: z.enum(RESTAURANT_ROLES),
});

export const removeMemberSchema = z.object({ tenantId: uuid, memberId: uuid });
