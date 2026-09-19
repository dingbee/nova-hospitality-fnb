import { createFileRoute } from "@tanstack/react-router";
import { ReconciliationCentre } from "@/modules/restaurant/reconciliation/ui/ReconciliationCentre";
import { productTitle } from "@/config/product";

export const Route = createFileRoute("/_authenticated/admin/restaurant/reconciliation")({
  head: () => ({
    meta: [
      { title: productTitle("Reconciliation & Daily Close") },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ReconciliationCentre,
});