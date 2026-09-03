import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/os/PageHeader";
import { PosWorkspace } from "@/modules/restaurant/sales/ui/PosWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/pos")({
  head: () => ({
    meta: [
      { title: "POS — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Touch till for the outlet: tables, orders, modifiers, kitchen routing, payments and receipts.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PosPage,
});

function PosPage() {
  return (
    <div className="space-y-4 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:gap-4 lg:space-y-0">
      <div className="lg:shrink-0">
        <PageHeader
          title="Point of sale"
          description="Table → order → kitchen → payment → receipt. Every sale posts revenue, cost and stock through the same engine."
        />
      </div>
      <PosWorkspace className="lg:min-h-0 lg:flex-1" />
    </div>
  );
}
