import { createFileRoute } from "@tanstack/react-router";
import { WhatsAppOperationsCentre } from "@/modules/messaging/ui/WhatsAppOperationsCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/whatsapp")({
  head: () => ({
    meta: [
      { title: "WhatsApp Operations — LexiBite" },
      { name: "description", content: "Tenant-scoped WhatsApp inbox, guest CRM, campaigns and conversion analytics." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: WhatsAppOperationsCentre,
});
