import { createFileRoute } from "@tanstack/react-router";
import { ReadinessCentre } from "@/modules/restaurant/readiness/ui/ReadinessCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/setup")({
  head: () => ({
    meta: [
      { title: "Readiness Centre — Restaurant & Bar OS" },
      {
        name: "description",
        content: "What must be configured or fixed before this restaurant is ready to operate.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ReadinessCentre,
});
