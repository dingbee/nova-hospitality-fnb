import { createFileRoute } from "@tanstack/react-router";
import { PricingCentre } from "@/modules/restaurant/pricing/ui/PricingCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing Centre — Restaurant & Bar OS" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PricingCentre,
});
