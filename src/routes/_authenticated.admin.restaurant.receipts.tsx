import { createFileRoute } from "@tanstack/react-router";
import { ReceiptCentre } from "@/modules/restaurant/sales/ui/ReceiptCentre";

export const Route = createFileRoute("/_authenticated/admin/restaurant/receipts")({
  head: () => ({
    meta: [
      { title: "Receipt Centre — Restaurant & Bar OS" },
      {
        name: "description",
        content:
          "Find, reprint and deliver every settled restaurant receipt at NOVA, with full traceability back to the order.",
      },
      { property: "og:title", content: "Receipt Centre — Restaurant & Bar OS" },
      { property: "og:description", content: "Every settled bill, searchable by receipt number, guest or period." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ReceiptCentre,
});