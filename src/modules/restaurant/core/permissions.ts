/**
 * Restaurant & Bar OS — capability map.
 *
 * Roles are commercial hospitality roles stored in `restaurant_members`
 * (tenant-scoped). They are separate from host platform roles: a platform
 * owner/admin/manager keeps oversight, but day-to-day restaurant permissions
 * are per-tenant so the module can be sold to other operators.
 *
 * This map mirrors the RLS policies in Postgres. It exists for UI affordances
 * only — the database remains the enforcement point.
 */
import type { RestaurantRole } from "./contracts";

export const RESTAURANT_ROLE_LABELS: Record<RestaurantRole, string> = {
  owner: "Owner",
  general_manager: "General Manager",
  restaurant_manager: "Restaurant Manager",
  chef: "Chef",
  kitchen_manager: "Kitchen Manager",
  bartender: "Bartender",
  inventory_manager: "Inventory Manager",
  purchasing_officer: "Purchasing Officer",
  accountant: "Accountant",
  viewer: "Viewer",
};

export const RESTAURANT_CAPABILITIES = [
  "tenant.manage",
  "location.manage",
  "menu.manage",
  "menu.delete",
  "guest.context.read",
  "guest.context.manage",
  "recipe.manage",
  "product.manage",
  "production.manage",
  "inventory.manage",
  "supplier.manage",
  "purchase.request",
  "purchasing.manage",
  "purchasing.approve",
  "receiving.manage",
  "invoice.manage",
  "variance.manage",
  "costing.manage",
  "transfer.manage",
  "transfer.approve",
  "stocktake.manage",
  "stocktake.approve",
  "waste.record",
  "adjustment.manage",
  "reservation.manage",
  "batch.manage",
  "reconciliation.run",
  "reconciliation.declare",
  "reconciliation.close",
  "reconciliation.reopen",
  "reconciliation.resolve",
  "sales.manage",
  "sales.void",
  "sales.reopen",
  "sales.discount",
  "sales.room_charge",
  "kitchen.manage",
  "stock.manage",
  "profitability.manage",
  "intelligence.read",
  "pricing.manage",
  "pricing.approve",
  "discount.manage",
  "tax.manage",
  "requisition.create",
  "requisition.approve",
  "requisition.issue",
  "documents.audit.read",
] as const;
export type RestaurantCapability = (typeof RESTAURANT_CAPABILITIES)[number];

const CAPABILITY_ROLES: Record<RestaurantCapability, readonly RestaurantRole[]> = {
  // Who took a document out of the system, when, and in what format.
  "documents.audit.read": ["owner", "general_manager", "restaurant_manager", "accountant"],
  "tenant.manage": ["owner", "general_manager"],
  "location.manage": ["owner", "general_manager", "restaurant_manager"],
  "menu.manage": ["owner", "general_manager", "restaurant_manager", "chef", "kitchen_manager"],
  // Destructive deletion and guest health data are narrower than menu editing.
  "menu.delete": ["owner", "general_manager", "restaurant_manager"],
  "guest.context.read": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "chef",
    "kitchen_manager",
    "bartender",
  ],
  "guest.context.manage": ["owner", "general_manager", "restaurant_manager", "chef", "kitchen_manager"],
  "recipe.manage": ["owner", "general_manager", "restaurant_manager", "chef", "kitchen_manager"],
  "product.manage": ["owner", "general_manager", "restaurant_manager", "chef", "kitchen_manager"],
  "production.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "chef",
    "kitchen_manager",
    "inventory_manager",
  ],
  "inventory.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "inventory_manager",
    "kitchen_manager",
    "chef",
    "bartender",
  ],
  "supplier.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "purchasing_officer",
    "inventory_manager",
  ],
  "purchase.request": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "purchasing_officer",
    "inventory_manager",
    "kitchen_manager",
    "chef",
    "bartender",
  ],
  "purchasing.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "purchasing_officer",
    "inventory_manager",
    "accountant",
  ],
  "purchasing.approve": ["owner", "general_manager", "restaurant_manager"],
  "receiving.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "inventory_manager",
    "purchasing_officer",
    "kitchen_manager",
    "chef",
  ],
  "invoice.manage": ["owner", "general_manager", "restaurant_manager", "accountant", "purchasing_officer"],
  "variance.manage": ["owner", "general_manager", "restaurant_manager", "accountant", "purchasing_officer"],
  "costing.manage": ["owner", "general_manager", "restaurant_manager", "chef", "kitchen_manager", "accountant"],
  "transfer.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "inventory_manager",
    "kitchen_manager",
    "chef",
    "bartender",
  ],
  "transfer.approve": ["owner", "general_manager", "restaurant_manager", "inventory_manager"],
  "stocktake.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "inventory_manager",
    "kitchen_manager",
    "chef",
    "bartender",
  ],
  "stocktake.approve": ["owner", "general_manager", "restaurant_manager", "inventory_manager", "accountant"],
  "waste.record": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "inventory_manager",
    "kitchen_manager",
    "chef",
    "bartender",
  ],
  "adjustment.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "inventory_manager",
    "kitchen_manager",
  ],
  "reservation.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "inventory_manager",
    "kitchen_manager",
    "chef",
    "bartender",
  ],
  "batch.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "inventory_manager",
    "kitchen_manager",
    "chef",
    "purchasing_officer",
  ],
  "reconciliation.run": ["owner", "general_manager", "restaurant_manager", "inventory_manager", "accountant"],
  // Declaring is a floor activity; closing and reopening the day are not.
  "reconciliation.declare": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "accountant",
    "bartender",
  ],
  "reconciliation.close": ["owner", "general_manager", "restaurant_manager", "accountant"],
  "reconciliation.reopen": ["owner", "general_manager", "accountant"],
  "reconciliation.resolve": ["owner", "general_manager", "restaurant_manager", "accountant"],
  "sales.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "bartender",
    "chef",
    "kitchen_manager",
    "accountant",
  ],
  // Money-affecting corrections stay with supervisors: a void, a reopen or a
  // manual discount rewrites revenue evidence after the fact.
  "sales.void": ["owner", "general_manager", "restaurant_manager"],
  "sales.reopen": ["owner", "general_manager", "restaurant_manager"],
  "sales.discount": ["owner", "general_manager", "restaurant_manager"],
  // Charging a guest room moves money outside the outlet: it stays with
  // supervisors and the bar/floor staff trusted to identify a guest.
  "sales.room_charge": ["owner", "general_manager", "restaurant_manager", "bartender", "accountant"],
  "kitchen.manage": ["owner", "general_manager", "restaurant_manager", "chef", "kitchen_manager", "bartender"],
  "stock.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "inventory_manager",
    "kitchen_manager",
    "chef",
    "bartender",
    "purchasing_officer",
  ],
  "profitability.manage": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "chef",
    "kitchen_manager",
    "accountant",
  ],
  "intelligence.read": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "chef",
    "kitchen_manager",
    "inventory_manager",
    "purchasing_officer",
    "accountant",
  ],
  "pricing.manage": ["owner", "general_manager", "restaurant_manager", "accountant"],
  "pricing.approve": ["owner", "general_manager"],
  "discount.manage": ["owner", "general_manager", "restaurant_manager"],
  "tax.manage": ["owner", "general_manager", "accountant"],
  "requisition.create": [
    "owner",
    "general_manager",
    "restaurant_manager",
    "chef",
    "kitchen_manager",
    "bartender",
    "inventory_manager",
  ],
  "requisition.approve": ["owner", "general_manager", "restaurant_manager", "inventory_manager"],
  "requisition.issue": ["owner", "general_manager", "restaurant_manager", "inventory_manager"],
};

export function rolesForCapability(capability: RestaurantCapability): readonly RestaurantRole[] {
  return CAPABILITY_ROLES[capability];
}

export function hasRestaurantCapability(
  roles: readonly string[],
  capability: RestaurantCapability,
  platformAdmin = false,
): boolean {
  if (platformAdmin) return true;
  return roles.some((r) => (CAPABILITY_ROLES[capability] as readonly string[]).includes(r));
}