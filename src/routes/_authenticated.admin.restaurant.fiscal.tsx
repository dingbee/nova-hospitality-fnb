import { createFileRoute } from "@tanstack/react-router";
import { FiscalCentre } from "@/modules/restaurant/fiscal/ui/FiscalCentre";
import { productTitle } from "@/config/product";

export const Route = createFileRoute("/_authenticated/admin/restaurant/fiscal")({
  head: () => ({
    meta: [
      { title: productTitle("Fiscal / TRA") },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: FiscalCentre,
});
