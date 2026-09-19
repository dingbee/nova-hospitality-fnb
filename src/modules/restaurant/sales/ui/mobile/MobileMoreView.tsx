/* eslint-disable @typescript-eslint/no-explicit-any -- `to` is data-driven here, same as DocumentCentre's workflowRoute links; the router can't type-check a dynamic path list. */
import { Link } from "@tanstack/react-router";
import { BarChart3, ChevronRight, ClipboardList, Package, Settings, UtensilsCrossed } from "lucide-react";
import { hasRestaurantCapability } from "@/modules/restaurant/core/permissions";
import type { LexiBiteMobilePosData } from "./useLexiBiteMobilePos";

/**
 * Screen 8 — an operational menu, not a feature list: every destination is
 * an existing admin route, gated by the same capability map the rest of the
 * app already enforces server-side (this list is a convenience only — see
 * permissions.ts's own doc comment).
 */
export function MobileMoreView({
  data,
  onNewOrder,
  onOpenTables,
}: {
  data: LexiBiteMobilePosData;
  onNewOrder: () => void;
  onOpenTables: () => void;
}) {
  const roles = data.roles;
  const admin = data.platformAdmin;

  const items: {
    label: string;
    description: string;
    icon: typeof UtensilsCrossed;
    onClick?: () => void;
    to?: string;
    visible: boolean;
  }[] = [
    {
      label: "New Order",
      description: "Start a walk-in or bar tab",
      icon: UtensilsCrossed,
      onClick: onNewOrder,
      visible: true,
    },
    {
      label: "Open Tables",
      description: "View and manage tables",
      icon: ClipboardList,
      onClick: onOpenTables,
      visible: true,
    },
    {
      label: "Menu Management",
      description: "Update items and availability",
      icon: UtensilsCrossed,
      to: "/admin/restaurant/menu",
      visible: hasRestaurantCapability(roles, "menu.manage", admin),
    },
    {
      label: "Inventory",
      description: "Check stock levels",
      icon: Package,
      to: "/admin/restaurant/inventory",
      visible: hasRestaurantCapability(roles, "stock.manage", admin),
    },
    {
      label: "Reports",
      description: "View sales and performance",
      icon: BarChart3,
      to: "/admin/restaurant/intelligence",
      visible: hasRestaurantCapability(roles, "intelligence.read", admin),
    },
    {
      label: "Settings",
      description: "POS and outlet preferences",
      icon: Settings,
      to: "/admin/restaurant/settings",
      visible: hasRestaurantCapability(roles, "location.manage", admin),
    },
  ];

  return (
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 pb-4 pt-3">
      {items
        .filter((i) => i.visible)
        .map((i) =>
          i.to ? (
            <Link
              key={i.label}
              to={i.to as any}
              className="flex min-h-16 w-full items-center gap-3 rounded-xl border bg-card p-4 active:bg-muted"
            >
              <MoreRowContent icon={i.icon} label={i.label} description={i.description} />
            </Link>
          ) : (
            <button
              key={i.label}
              type="button"
              onClick={i.onClick}
              className="flex min-h-16 w-full items-center gap-3 rounded-xl border bg-card p-4 text-left active:bg-muted"
            >
              <MoreRowContent icon={i.icon} label={i.label} description={i.description} />
            </button>
          ),
        )}
    </div>
  );
}

function MoreRowContent({
  icon: Icon,
  label,
  description,
}: {
  icon: typeof UtensilsCrossed;
  label: string;
  description: string;
}) {
  return (
    <>
      <span
        className="flex size-11 shrink-0 items-center justify-center rounded-full"
        style={{ background: "color-mix(in oklab, var(--lb-green) 12%, white)", color: "var(--lb-green)" }}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </>
  );
}
