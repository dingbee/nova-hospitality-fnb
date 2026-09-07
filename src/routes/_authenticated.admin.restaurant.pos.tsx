import { createFileRoute } from "@tanstack/react-router";
import { PosPageHeader } from "@/modules/restaurant/sales/ui/PosPageHeader";
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
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PosPageHeader
        title="Restaurant POS"
        description="Table → order → kitchen → payment → receipt."
      />
      <PosWorkspace className="min-h-0 flex-1" />
    </div>
  );
}
