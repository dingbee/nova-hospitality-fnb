import { createFileRoute } from "@tanstack/react-router";
import { ChannelIntegrationsCentre } from "@/modules/api-platform/ui/ChannelIntegrationsCentre";
import { StayNasIntegrationCentre } from "@/modules/api-platform/ui/StayNasIntegrationCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/integrations")({
  head: () => ({
    meta: [
      { title: "Channel Integrations — Restaurant & Bar OS" },
      { name: "description", content: "Manage ordering channels and connected hospitality products in LexiBite." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: () => (
    <div className="space-y-10">
      <ChannelIntegrationsCentre />

      <section aria-labelledby="staynas-integration-heading" className="space-y-4 border-t pt-8">
        <div>
          <h2 id="staynas-integration-heading" className="text-xl font-semibold tracking-tight">
            StayNas × LexiBite
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Property mapping, secure credential exchange and reciprocal connection approval.
          </p>
        </div>
        <StayNasIntegrationCentre />
      </section>
    </div>
  ),
});
