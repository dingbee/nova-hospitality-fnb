import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/os/PageHeader";
import { PosWorkspace } from "@/modules/restaurant/sales/ui/PosWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/pos")({
  head: () => ({
    meta: [
      { title: "POS — Restaurant & Bar OS" },
      {
        name: "description",
        content: "Touch till for the outlet: tables, orders, modifiers, kitchen routing, payments and receipts.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PosPage,
});

function PosPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Point of sale"
        description="Table → order → kitchen → payment → receipt. Every sale posts revenue, cost and stock through the same engine."
      />
      <PosWorkspace />
    </div>
  );
}