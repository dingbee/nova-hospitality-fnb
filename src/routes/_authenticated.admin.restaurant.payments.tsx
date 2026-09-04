import { createFileRoute } from "@tanstack/react-router";
import { MobileMoneySettingsPanel } from "@/modules/restaurant/payments/mobilemoney/ui/MobileMoneySettingsPanel";

export const Route = createFileRoute("/_authenticated/admin/restaurant/payments")({
  head: () => ({
    meta: [
      { title: "Mobile Money — NOVA Restaurant OS" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: MobileMoneySettingsPanel,
});
