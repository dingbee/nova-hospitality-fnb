import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import {
  BookOpen,
  Boxes,
  Brain,
  Scale,
  Calculator,
  ChefHat,
  ClipboardCheck,
  CookingPot,
  CreditCard,
  LayoutDashboard,
  PiggyBank,
  Receipt,
  Scale as ScaleIcon,
  Tags,
  Settings2,
  ShoppingCart,
  Truck,
  ClipboardList,
  Wrench,
  Wine,
  GlassWater,
} from "lucide-react";
// Declares Restaurant & Bar OS to the Intelligence Core registry (inert registration).
import "@/modules/restaurant/intelligence/provider";

export const Route = createFileRoute("/_authenticated/admin/restaurant")({
  head: () => ({
    meta: [
      { title: "Restaurant & Bar OS — NOVA Hospitality F&B" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: RestaurantLayout,
});

/** Operational grouping — workflow-first, not dashboard-first. */
const GROUPS = [
  {
    label: "Operations",
    items: [
      { to: "/admin/restaurant", label: "Overview", icon: LayoutDashboard, exact: true },
      { to: "/admin/restaurant/pos", label: "POS", icon: CreditCard },
      { to: "/admin/restaurant/orders", label: "Orders", icon: Receipt },
      { to: "/admin/restaurant/kitchen", label: "Kitchen", icon: ChefHat },
      { to: "/admin/restaurant/bar", label: "Bar", icon: Wine, exact: true },
      { to: "/admin/restaurant/bar/pos", label: "Bar POS", icon: GlassWater },
      { to: "/admin/restaurant/menu", label: "Menu", icon: BookOpen },
    ],
  },
  {
    label: "Inventory",
    items: [
      { to: "/admin/restaurant/inventory-control", label: "Inventory Centre", icon: Boxes },
      { to: "/admin/restaurant/inventory", label: "Stock items", icon: Boxes },
      { to: "/admin/restaurant/stock", label: "Movements", icon: Boxes },
      { to: "/admin/restaurant/requisitions", label: "Requisitions", icon: ClipboardList },
    ],
  },
  {
    label: "Procurement",
    items: [
      { to: "/admin/restaurant/procurement", label: "Procurement Centre", icon: ClipboardCheck },
      { to: "/admin/restaurant/purchasing", label: "Purchase orders", icon: ShoppingCart },
      { to: "/admin/restaurant/suppliers", label: "Suppliers", icon: Truck },
    ],
  },
  {
    label: "Products",
    items: [{ to: "/admin/restaurant/products", label: "Products & Recipes", icon: CookingPot }],
  },
  {
    label: "Commercial",
    items: [
      { to: "/admin/restaurant/pricing", label: "Pricing Centre", icon: Tags },
      { to: "/admin/restaurant/costing", label: "Costing", icon: Calculator },
      { to: "/admin/restaurant/profitability", label: "Profitability", icon: PiggyBank },
      { to: "/admin/restaurant/reconciliation", label: "Reconciliation", icon: ScaleIcon },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { to: "/admin/restaurant/intelligence", label: "Insights", icon: Brain },
      { to: "/admin/restaurant/decisions", label: "Decisions", icon: Scale },
      { to: "/admin/restaurant/settings", label: "Settings", icon: Settings2 },
    ],
  },
  {
    label: "Setup",
    items: [{ to: "/admin/restaurant/setup", label: "Restaurant setup", icon: Wrench }],
  },
] as const;

function RestaurantLayout() {
  return (
    <div className="space-y-4">
      <nav className="flex flex-col gap-2 rounded-lg border bg-card p-2 text-sm">
        {GROUPS.map((g) => (
          <div key={g.label} className="flex flex-wrap items-center gap-1">
            <span className="w-24 shrink-0 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {g.label}
            </span>
            {g.items.map((t) => (
              <Link
                key={t.to}
                to={t.to as string}
                activeOptions={{ exact: (t as { exact?: boolean }).exact ?? false }}
                activeProps={{ className: "bg-primary text-primary-foreground" }}
                inactiveProps={{ className: "text-muted-foreground hover:bg-muted" }}
                className="inline-flex min-h-10 items-center gap-1.5 rounded px-3 py-1.5"
              >
                <t.icon className="size-4" /> {t.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}