import { createFileRoute } from "@tanstack/react-router";
import { RequisitionsWorkspace } from "@/modules/restaurant/requisitions/ui/RequisitionsWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/requisitions")({
  validateSearch: (search: Record<string, unknown>) => ({
    status: typeof search.status === "string" ? search.status : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Requisitions — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Kitchen, bar and department requisitions: request stock from a store, approve, reject and issue through the ledger.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: RequisitionsRoute,
});

function RequisitionsRoute() {
  const { status } = Route.useSearch();
  return <RequisitionsWorkspace initialStatus={status} />;
}
