import { createFileRoute } from "@tanstack/react-router";
import { MobileMoneySettingsPanel } from "@/modules/restaurant/payments/mobilemoney/ui/MobileMoneySettingsPanel";
import { productTitle } from "@/config/product";

export const Route = createFileRoute("/_authenticated/admin/restaurant/payments")({
  head: () => ({
    meta: [
      { title: productTitle("Mobile Money") },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: MobileMoneySettingsPanel,
});
