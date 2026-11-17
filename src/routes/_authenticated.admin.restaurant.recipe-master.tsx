import { createFileRoute } from "@tanstack/react-router";
import { RecipeImportWorkbench } from "@/modules/restaurant/recipes/ui/RecipeImportWorkbench";

export const Route = createFileRoute("/_authenticated/admin/restaurant/recipe-master")({
  head: () => ({
    meta: [
      { title: "F&B Recipe Master — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Imported lunch and dinner recipe books mapped to the F&B master catalog: ingredient mapping, costing completeness and import audit.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: RecipeImportWorkbench,
});
