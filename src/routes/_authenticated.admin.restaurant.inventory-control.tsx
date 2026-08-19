import { createFileRoute } from "@tanstack/react-router";
import { InventoryCentre } from "@/modules/restaurant/inventory/ui/InventoryCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/inventory-control")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Inventory Centre — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Multi-location stock positions, transfers, waste, adjustments, stocktakes, batches and ledger reconciliation.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: InventoryControlRoute,
});

function InventoryControlRoute() {
  const { tab } = Route.useSearch();
  return <InventoryCentre initialTab={tab} />;
}