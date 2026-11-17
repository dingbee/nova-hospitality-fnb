import { Link } from "@tanstack/react-router";
import {
  Boxes,
  ChefHat,
  ClipboardList,
  Factory,
  Package,
  Receipt,
  Scale,
  Trash2,
  Truck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SectionCard } from "@/components/os/SectionCard";
import {
  hasRestaurantCapability,
  type RestaurantCapability,
} from "@/modules/restaurant/core/permissions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";

type QuickAction = {
  label: string;
  hint: string;
  icon: LucideIcon;
  to: string;
  tab?: string;
  capability: RestaurantCapability;
};

/**
 * Action-first launcher. Every entry routes into an existing workflow —
 * no business logic lives here.
 */
export const RESTAURANT_QUICK_ACTIONS: QuickAction[] = [
  { label: "Open the till", hint: "Tables, orders, payments, receipts", icon: Receipt, to: "/admin/restaurant/pos", capability: "sales.manage" },
  { label: "Receive delivery", hint: "Post a goods receipt against a PO", icon: Truck, to: "/admin/restaurant/procurement", tab: "receiving", capability: "receiving.manage" },
  { label: "Create purchase request", hint: "Raise a need for approval", icon: ClipboardList, to: "/admin/restaurant/procurement", tab: "requests", capability: "purchase.request" },
  { label: "Transfer stock", hint: "Move stock between outlets", icon: Boxes, to: "/admin/restaurant/inventory-control", tab: "transfers", capability: "transfer.manage" },
  { label: "Record waste", hint: "Spoilage, breakage or adjustment", icon: Trash2, to: "/admin/restaurant/inventory-control", tab: "waste", capability: "waste.record" },
  { label: "Start stocktake", hint: "Count a location and reconcile", icon: Scale, to: "/admin/restaurant/inventory-control", tab: "stocktake", capability: "stocktake.manage" },
  { label: "Add product", hint: "New sellable product", icon: Package, to: "/admin/restaurant/products", tab: "products", capability: "product.manage" },
  { label: "Create recipe", hint: "Versioned recipe with cost preview", icon: ChefHat, to: "/admin/restaurant/products", tab: "recipes", capability: "recipe.manage" },
  { label: "Start production run", hint: "Batch prep and record yield", icon: Factory, to: "/admin/restaurant/products", tab: "production", capability: "production.manage" },
];

export function RestaurantQuickActions({ limit }: { limit?: number }) {
  const ws = useRestaurantWorkspace();
  const roles = ws.data?.roles ?? [];
  const platformAdmin = ws.data?.platformAdmin ?? false;

  const allowed = RESTAURANT_QUICK_ACTIONS.filter((a) =>
    hasRestaurantCapability(roles as readonly string[], a.capability, platformAdmin),
  ).slice(0, limit ?? RESTAURANT_QUICK_ACTIONS.length);

  if (allowed.length === 0) return null;

  return (
    <SectionCard
      title="Quick actions"
      description="Start a daily task. Each action opens the existing workflow for your role."
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {allowed.map((a) => (
          <Link
            key={a.label}
            to={a.to}
            search={a.tab ? ({ tab: a.tab } as never) : undefined}
            className="flex min-h-16 items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <a.icon className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{a.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{a.hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </SectionCard>
  );
}
