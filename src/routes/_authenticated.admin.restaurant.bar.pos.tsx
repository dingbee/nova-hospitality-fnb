import { createFileRoute } from "@tanstack/react-router";
import { PosPageHeader } from "@/modules/restaurant/sales/ui/PosPageHeader";
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
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PosPageHeader title="Bar POS" description="Counter/seat → drinks → tab → bill → payment." />
      <PosWorkspace lens="bar" className="min-h-0 flex-1" />
    </div>
  );
}
