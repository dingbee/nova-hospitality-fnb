import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/os/PageHeader";
import { PosWorkspace } from "@/modules/restaurant/sales/ui/PosWorkspace";

export const Route = createFileRoute("/_authenticated/admin/restaurant/bar/pos")({
  head: () => ({
    meta: [
      { title: "Bar POS — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Fast bar till for the outlet: counter tabs, bar seats, drinks, pours, running tabs, payment and receipts.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: BarPosPage,
});

function BarPosPage() {
  return (
    <div className="space-y-4 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:gap-4 lg:space-y-0">
      <div className="lg:shrink-0">
        <PageHeader
          title="Bar POS"
          description="Counter or seat → drinks → bar prep → running tab → bill → payment → receipt. Same order, pricing and ledger engine as the restaurant till."
        />
      </div>
      <PosWorkspace lens="bar" className="lg:min-h-0 lg:flex-1" />
    </div>
  );
}
