import { createFileRoute } from "@tanstack/react-router";
import { FounderWhatsAppControlCentre } from "@/modules/messaging/ui/FounderWhatsAppControlCentre";

export const Route = createFileRoute("/_authenticated/admin/commercial/whatsapp")({
  head: () => ({
    meta: [
      { title: "WhatsApp Platform Control — LexiBite" },
      { name: "description", content: "Founder-only WhatsApp provider health, usage, billing evidence and security posture." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: FounderWhatsAppControlCentre,
});
