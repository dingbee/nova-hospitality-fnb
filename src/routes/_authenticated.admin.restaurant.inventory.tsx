import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/os/PageHeader";
import { SectionCard } from "@/components/os/SectionCard";
import { EmptyState } from "@/components/os/EmptyState";
import { listRestaurantInventoryFn } from "@/modules/restaurant/inventory/inventory.functions";
import { useRestaurantWorkspace } from "@/modules/restaurant/ui/useRestaurantWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/inventory")({
  head: () => ({
    meta: [
      { title: "Inventory — Restaurant & Bar OS" },
      { name: "description", content: "Stock items, par levels and reorder points across restaurant outlets." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: InventoryPage,
});

function InventoryPage() {
  const ws = useRestaurantWorkspace();
  const tenantId = ws.data?.tenant?.id;
  const fn = useServerFn(listRestaurantInventoryFn);
  const q = useQuery({
    queryKey: ["restaurant.inventory", tenantId],
    queryFn: () => fn({ data: { tenantId: tenantId!, lowOnly: false, limit: 200 } }),
    enabled: Boolean(tenantId),
  });
  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inventory"
        description="Ingredients, beverages and consumables with par levels and reorder points."
      />
      <SectionCard title="Stock items" description={`${rows.filter((r) => r.low).length} at or below reorder point.`}>
        {rows.length === 0 ? (
          <EmptyState title="No stock items" description="Add inventory items to begin tracking stock." />
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <span className={r.low ? "text-destructive" : undefined}>{r.name}</span>
                <span className="text-xs text-muted-foreground">
                  {Number(r.current_quantity)} on hand
                  {r.reorder_point != null ? ` · reorder at ${Number(r.reorder_point)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}