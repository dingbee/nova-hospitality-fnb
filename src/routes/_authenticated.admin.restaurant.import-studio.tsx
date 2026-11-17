import { createFileRoute } from "@tanstack/react-router";
import { ImportStudio } from "@/modules/restaurant/import/ui/ImportStudio";

export const Route = createFileRoute("/_authenticated/admin/restaurant/import-studio")({
  head: () => ({
    meta: [
      { title: "Import Studio — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Bring your restaurant data into LexiBite with the LexiBite Import Template, or use LexiBite Intelligence to understand an existing spreadsheet — reviewed before anything is imported.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ImportStudio,
});
