import { createFileRoute } from "@tanstack/react-router";
import { SetupWorkbench } from "@/modules/restaurant/masterdata/ui/SetupWorkbench";

export const Route = createFileRoute("/_authenticated/admin/restaurant/setup")({
  head: () => ({
    meta: [
      { title: "Restaurant Setup — Restaurant & Bar OS" },
      {
        name: "description",
        content: "Configure a restaurant from blank: business, outlets, stores, units, categories, items and suppliers.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SetupWorkbench,
});