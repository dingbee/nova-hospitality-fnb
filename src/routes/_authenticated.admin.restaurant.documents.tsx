import { createFileRoute } from "@tanstack/react-router";
import { DocumentCentre } from "@/modules/restaurant/documents/ui/DocumentCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/documents")({
  head: () => ({
    meta: [
      { title: "Document Centre — Restaurant & Bar OS" },
      {
        name: "description",
        content: "Find, preview, print and export every restaurant operational document with a full audit trail.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: DocumentCentre,
});