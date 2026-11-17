import { createFileRoute } from "@tanstack/react-router";
import { MobileMoneySettingsPanel } from "@/modules/restaurant/payments/mobilemoney/ui/MobileMoneySettingsPanel";
import { PesapalSettingsPanel } from "@/modules/restaurant/payments/ui/PesapalSettingsPanel";

export const Route = createFileRoute("/_authenticated/admin/restaurant/payments")({
  head: () => ({
    meta: [
      { title: "Payments — LexiBite" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PaymentsSettingsCentre,
});

function PaymentsSettingsCentre() {
  return (
    <div className="space-y-8">
      <MobileMoneySettingsPanel />
      <PesapalSettingsPanel />
    </div>
  );
}
