import { createFileRoute } from "@tanstack/react-router";
import { ChannelCatalogueAdmin } from "@/modules/api-platform/ui/ChannelCatalogueAdmin";

export const Route = createFileRoute("/_authenticated/admin/commercial/channels")({
  head: () => ({
    meta: [
      { title: "Universal Channel Catalogue — LexiBite" },
      { name: "description", content: "Platform-controlled universal channel catalogue." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ChannelCatalogueAdmin,
});
