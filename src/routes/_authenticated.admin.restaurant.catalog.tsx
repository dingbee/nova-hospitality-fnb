import { createFileRoute } from "@tanstack/react-router";
import { CatalogWorkbench } from "@/modules/restaurant/catalog/ui/CatalogWorkbench";

export const Route = createFileRoute("/_authenticated/admin/restaurant/catalog")({
  head: () => ({
    meta: [
      { title: "F&B Master Catalog — Restaurant & Bar OS" },
      {
        name: "description",
        content: "Search, filter and audit the F&B master catalog: SKUs, domains, categories, pack sizes and data quality.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CatalogWorkbench,
});
