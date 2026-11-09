import { createFileRoute } from "@tanstack/react-router";
import { StayNasIntegrationCentre } from "@/modules/api-platform/ui/StayNasIntegrationCentre";

export const Route = createFileRoute("/_authenticated/admin/staynas-integration")({
  head: () => ({
    meta: [
      { title: "StayNas Connection — LexiBite" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: StayNasIntegrationCentre,
});
