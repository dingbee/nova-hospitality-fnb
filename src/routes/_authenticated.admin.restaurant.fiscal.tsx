import { createFileRoute } from "@tanstack/react-router";
import { FiscalCentre } from "@/modules/restaurant/fiscal/ui/FiscalCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/fiscal")({
  head: () => ({
    meta: [
      { title: "Fiscal / TRA — NOVA Restaurant OS" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: FiscalCentre,
});
