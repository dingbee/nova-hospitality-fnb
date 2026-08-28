import { createFileRoute } from "@tanstack/react-router";
import { ImportStudio } from "@/modules/restaurant/import/ui/ImportStudio";

export const Route = createFileRoute("/_authenticated/admin/restaurant/import-studio")({
  head: () => ({
    meta: [
      { title: "Import Studio — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Bring existing menu, inventory, supplier and recipe data into NoVA — mapped, matched and reviewed before anything is imported.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ImportStudio,
});
