import { createFileRoute } from "@tanstack/react-router";
import { ChannelIntegrationsCentre } from "@/modules/api-platform/ui/ChannelIntegrationsCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/integrations")({
  head: () => ({
    meta: [
      { title: "Channel Integrations — Restaurant & Bar OS" },
      { name: "description", content: "Connect external ordering and delivery channels to LexiBite." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ChannelIntegrationsCentre,
});
