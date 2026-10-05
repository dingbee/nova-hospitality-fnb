import { createFileRoute } from "@tanstack/react-router";
import { ChannelIntegrationsCentre } from "@/modules/api-platform/ui/ChannelIntegrationsCentre";

/**
 * Compatibility alias for the singular URL.
 *
 * Canonical route: /admin/restaurant/integrations
 * Keep both URLs functional so copied/bookmarked tenant links do not fall
 * into the generic not-found surface.
 */
export const Route = createFileRoute("/_authenticated/admin/restaurant/integration")({
  head: () => ({
    meta: [
      { title: "Channel Integrations — Restaurant & Bar OS" },
      { name: "description", content: "Connect external ordering and delivery channels to LexiBite." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ChannelIntegrationsCentre,
});
