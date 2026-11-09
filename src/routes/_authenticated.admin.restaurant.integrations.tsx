import { createFileRoute, Link } from "@tanstack/react-router";
import { ChannelIntegrationsCentre } from "@/modules/api-platform/ui/ChannelIntegrationsCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/integrations")({
  head: () => ({
    meta: [
      { title: "Channel Integrations — Restaurant & Bar OS" },
      { name: "description", content: "Connect external ordering and delivery channels to LexiBite." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: () => (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Link to="/admin/restaurant/integrations/staynas" className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
          Manage StayNas property connection
        </Link>
      </div>
      <ChannelIntegrationsCentre />
    </div>
  ),
});
