import { createFileRoute } from "@tanstack/react-router";
import { CommercialCentre } from "@/modules/commercial/ui/CommercialCentre";
import { productTitle } from "@/config/product";

export const Route = createFileRoute("/_authenticated/admin/commercial")({
  head: () => ({
    meta: [
      { title: productTitle("Commercial Centre") },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CommercialCentre,
});
