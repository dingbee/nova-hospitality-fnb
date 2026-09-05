import { createFileRoute } from "@tanstack/react-router";
import { CommercialCentre } from "@/modules/commercial/ui/CommercialCentre";

export const Route = createFileRoute("/_authenticated/admin/commercial")({
  head: () => ({
    meta: [
      { title: "Commercial Centre — NOVA Hospitality F&B" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CommercialCentre,
});
