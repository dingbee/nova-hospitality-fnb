import { createFileRoute } from "@tanstack/react-router";
import { MainStoreWorkspace } from "@/modules/restaurant/inventory/ui/MainStoreWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/main-store")({
  head: () => ({
    meta: [
      { title: "Main Store — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Tenant central store: stock position, incoming orders, goods receiving, transfers, movement history, supplier deliveries and exceptions.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: MainStoreWorkspace,
});
