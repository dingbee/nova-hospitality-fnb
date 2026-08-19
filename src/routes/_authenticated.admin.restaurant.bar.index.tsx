import { createFileRoute } from "@tanstack/react-router";
import { BarWorkspace } from "@/modules/restaurant/bar/ui/BarWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/bar/")({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Bar Operations — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Bar service board, beverage stock, pour configuration, pour cost and theoretical-versus-actual variance for NOVA.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: BarIndexRoute,
});

function BarIndexRoute() {
  const { tab } = Route.useSearch();
  return <BarWorkspace initialTab={tab} />;
}
