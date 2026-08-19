import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Boxes, BookOpen, Calculator, ShoppingCart, Store, Truck } from "lucide-react";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { StatCard } from "@/components/os/StatCard";
import { EmptyState } from "@/components/os/EmptyState";
import { getRestaurantContextFn } from "@/modules/restaurant/intelligence/context.functions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";
import { RestaurantQuickActions } from "@/modules/restaurant/ui/RestaurantQuickActions";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/admin/restaurant/")({
  head: () => ({
    meta: [
      { title: "Restaurant & Bar OS Overview — NOVA Hospitality F&B" },
      {
        name: "description",
        content: "Outlets, menus, inventory, suppliers and purchasing at a glance for the active restaurant tenant.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: RestaurantOverview,
});

function RestaurantOverview() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const contextFn = useServerFn(getRestaurantContextFn);
  const ctx = useQuery({
    queryKey: ["restaurant.context", tenantId],
    queryFn: () => contextFn({ data: { tenantId: tenantId! } }),
    enabled: Boolean(tenantId),
  });

  if (ws.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading workspace…</div>;

  if (!ws.data?.tenant) {
    return (
      <EmptyState
        title="No restaurant tenant"
        description="You are not a member of any Restaurant & Bar OS tenant yet."
      />
    );
  }

  const d = ctx.data;
  const money = (v?: number) =>
    v == null ? "—" : `${ws.data?.properties[0]?.currency ?? "TZS"} ${v.toLocaleString()}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title={ws.data.tenant.name}
        description={`Restaurant & Bar OS · ${ws.data.subscription?.plan ?? "no plan"} · ${ws.data.locations.length} outlets`}
      />

      <RestaurantQuickActions />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Outlets" value={String(d?.locations ?? "—")} icon={Store} />
        <StatCard
          label="Menus published"
          value={d ? `${d.menus.published}/${d.menus.total}` : "—"}
          icon={BookOpen}
        />
        <StatCard
          label="Menu items available"
          value={d ? `${d.menuItems.available}/${d.menuItems.total}` : "—"}
          icon={BookOpen}
        />
        <StatCard
          label="Stock items"
          value={String(d?.inventory.total ?? "—")}
          icon={Boxes}
          hint={d ? `${d.inventory.low} at or below reorder point` : undefined}
        />
        <StatCard label="Stock value" value={money(d?.inventory.stockValue)} icon={Boxes} />
        <StatCard
          label="Suppliers"
          value={d ? `${d.suppliers.active}/${d.suppliers.total}` : "—"}
          icon={Truck}
        />
        <StatCard
          label="Open purchase orders"
          value={String(d?.purchasing.open ?? "—")}
          icon={ShoppingCart}
          hint={d ? money(d.purchasing.openValue) : undefined}
        />
        <StatCard
          label="Average food cost"
          value={d?.costing.averageFoodCostPercent != null ? `${d.costing.averageFoodCostPercent}%` : "—"}
          icon={Calculator}
          hint={d ? `${d.costing.costedItems} costed items` : undefined}
        />
      </div>

      <SectionCard
        title="Needs attention"
        description="Signals from the Intelligence Core, linked to where the work happens."
      >
        <ul className="grid gap-2 sm:grid-cols-3 text-sm">
          <li>
            <Link
              to="/admin/restaurant/inventory-control"
              search={{ tab: "positions" } as never}
              className="flex min-h-14 items-center rounded-lg border px-4 hover:bg-muted"
            >
              {d?.inventory.low ?? 0} items at or below reorder point
            </Link>
          </li>
          <li>
            <Link
              to="/admin/restaurant/procurement"
              search={{ tab: "requests" } as never}
              className="flex min-h-14 items-center rounded-lg border px-4 hover:bg-muted"
            >
              {d?.purchasing.open ?? 0} open purchase orders to follow up
            </Link>
          </li>
          <li>
            <Link
              to="/admin/restaurant/intelligence"
              className="flex min-h-14 items-center rounded-lg border px-4 hover:bg-muted"
            >
              Review restaurant insights and decisions
            </Link>
          </li>
        </ul>
      </SectionCard>

      <SectionCard title="Outlets" description="Service locations in this tenant.">
        {ws.data.locations.length === 0 ? (
          <EmptyState
            title="No outlets yet"
            description="Outlets are the service locations that own menus, orders and stock. Add your first restaurant, bar or kitchen in Settings to start operating."
          />
        ) : (
          <ul className="divide-y text-sm">
            {ws.data.locations.map((l) => (
              <li key={l.id} className="flex items-center justify-between py-2">
                <span>{l.name}</span>
                <span className="text-xs uppercase text-muted-foreground">
                  {l.location_type} · {l.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}