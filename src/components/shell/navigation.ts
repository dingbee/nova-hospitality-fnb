/** Canonical operational navigation. Visibility is permission-derived; routes enforce permissions server-side. */
import { BookOpen, Boxes, Brain, Calculator, ChefHat, ClipboardCheck, ClipboardList, CookingPot, CreditCard, FileText, GlassWater, LayoutDashboard, Library, PiggyBank, Receipt, Scale, ScrollText, Settings2, ShoppingCart, Tags, Truck, UserCog, Wine, Wrench, type LucideIcon } from "lucide-react";
import type { Permission } from "@/lib/rbac/permissions";

export interface NavItem { to: string; label: string; icon: LucideIcon; permission: Permission; exact?: boolean; hint?: string; }
export interface NavGroup { label: string; items: NavItem[]; }

export const NAV_GROUPS: NavGroup[] = [
  { label: "Service", items: [
    { to: "/admin/restaurant", label: "Overview", icon: LayoutDashboard, permission: "RESTAURANT:READ", exact: true, hint: "Today's service at a glance" },
    { to: "/admin/restaurant/pos", label: "Restaurant POS", icon: CreditCard, permission: "POS:READ", hint: "Take and settle table orders" },
    { to: "/admin/restaurant/bar/pos", label: "Bar POS", icon: GlassWater, permission: "POS:READ", hint: "Bar service and pour tracking" },
    { to: "/admin/restaurant/orders", label: "Orders", icon: Receipt, permission: "ORDERS:READ", hint: "Open, held and settled orders" },
    { to: "/admin/restaurant/receipts", label: "Receipts", icon: ScrollText, permission: "ORDERS:READ", hint: "Delivery and reprint of receipts" },
  ]},
  { label: "Kitchen & Bar", items: [
    { to: "/admin/restaurant/kitchen", label: "Kitchen", icon: ChefHat, permission: "KITCHEN:READ", hint: "Tickets, prep and production" },
    { to: "/admin/restaurant/bar", label: "Bar workspace", icon: Wine, permission: "BAR:READ", exact: true, hint: "Pours, lenses and bar stock" },
    { to: "/admin/restaurant/products", label: "Products & recipes", icon: CookingPot, permission: "MENU:READ", hint: "Dishes, drinks and their recipes" },
    { to: "/admin/restaurant/recipe-master", label: "Recipe master", icon: Library, permission: "MENU:READ", hint: "Master recipe library and yields" },
  ]},
  { label: "Menu & Pricing", items: [
    { to: "/admin/restaurant/menu", label: "Menu", icon: BookOpen, permission: "MENU:READ", hint: "Menus, sections and availability" },
    { to: "/admin/restaurant/catalog", label: "Catalogue", icon: Library, permission: "MENU:READ", hint: "Import and reconcile the master catalogue" },
    { to: "/admin/restaurant/pricing", label: "Pricing centre", icon: Tags, permission: "PRICING:READ", hint: "Price lists, rules and rounding" },
    { to: "/admin/restaurant/costing", label: "Costing", icon: Calculator, permission: "COSTING:READ", hint: "Recipe cost, yield and margin" },
  ]},
  { label: "Inventory", items: [
    { to: "/admin/restaurant/inventory-control", label: "Inventory centre", icon: Boxes, permission: "INVENTORY:READ", hint: "Counts, waste and variance control" },
    { to: "/admin/restaurant/inventory", label: "Stock items", icon: Boxes, permission: "INVENTORY:READ", hint: "Item master, units and pack sizes" },
    { to: "/admin/restaurant/stock", label: "Stock movements", icon: ClipboardList, permission: "INVENTORY:READ", hint: "Receipts, issues and adjustments" },
    { to: "/admin/restaurant/requisitions", label: "Requisitions", icon: ClipboardList, permission: "INVENTORY:READ", hint: "Store requests and issues" },
  ]},
  { label: "Procurement", items: [
    { to: "/admin/restaurant/procurement", label: "Procurement centre", icon: ClipboardCheck, permission: "PROCUREMENT:READ", hint: "Demand, approvals and governance" },
    { to: "/admin/restaurant/purchasing", label: "Purchase orders", icon: ShoppingCart, permission: "PROCUREMENT:READ", hint: "Raise, approve and receive orders" },
    { to: "/admin/restaurant/suppliers", label: "Suppliers", icon: Truck, permission: "SUPPLIERS:READ", hint: "Supplier records and terms" },
  ]},
  { label: "Finance", items: [
    { to: "/admin/restaurant/reconciliation", label: "Reconciliation", icon: Scale, permission: "FINANCE:READ", hint: "Sales, stock and cash reconciliation" },
    { to: "/admin/restaurant/profitability", label: "Profitability", icon: PiggyBank, permission: "FINANCE:READ", hint: "Contribution by item and outlet" },
    { to: "/admin/restaurant/documents", label: "Documents", icon: FileText, permission: "REPORTS:READ", hint: "Issued documents and numbering" },
  ]},
  { label: "Intelligence", items: [
    { to: "/admin/restaurant/intelligence", label: "Insights", icon: Brain, permission: "REPORTS:READ", hint: "Findings across the F&B operation" },
    { to: "/admin/restaurant/decisions", label: "Decisions", icon: Scale, permission: "REPORTS:READ", hint: "Recommendations awaiting a call" },
  ]},
  { label: "Administration", items: [
    { to: "/admin", label: "System", icon: LayoutDashboard, permission: "ADMINISTRATION:READ", exact: true, hint: "Installation and runtime status" },
    { to: "/admin/restaurant/setup", label: "Restaurant setup", icon: Wrench, permission: "SETTINGS:READ", hint: "Tenancy, outlets and master data" },
    { to: "/admin/restaurant/settings", label: "Settings", icon: Settings2, permission: "SETTINGS:READ", hint: "Operational preferences" },
  ]},
];

export const ACCOUNT_ITEM: NavItem = { to: "/admin/account", label: "My account", icon: UserCog, permission: "RESTAURANT:READ", hint: "Password and session" };
export function visibleGroups(permissions: readonly string[]): NavGroup[] {
  const held = new Set(permissions);
  return NAV_GROUPS.map((g) => ({ label: g.label, items: g.items.filter((i) => held.has(i.permission)) })).filter((g) => g.items.length > 0);
}
export function activeItem(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const group of NAV_GROUPS) for (const item of [...group.items, ACCOUNT_ITEM]) {
    const isMatch = item.exact ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);
    if (isMatch && (!best || item.to.length > best.to.length)) best = item;
  }
  return best;
}
export function groupOf(item: NavItem | null): string | null {
  if (!item) return null;
  return NAV_GROUPS.find((g) => g.items.some((i) => i.to === item.to))?.label ?? null;
}
