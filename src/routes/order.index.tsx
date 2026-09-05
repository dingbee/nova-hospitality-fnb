import { createFileRoute } from "@tanstack/react-router";
import { UtensilsCrossed } from "lucide-react";
import { PRODUCT } from "@/config/product";
import { GuestServiceWorker } from "@/modules/restaurant/selforder/GuestServiceWorker";

/**
 * The guest ordering experience is always table-scoped (/order/$tableId) —
 * there is no generic guest menu without a table. This route exists only so
 * the guest PWA's start_url (spec: "must lead to the guest experience,
 * never an admin route") resolves to a real, on-brand page instead of a
 * 404 when a guest relaunches the installed app from their home screen
 * without going through their table's QR link again.
 */
export const Route = createFileRoute("/order/")({
  head: () => ({
    meta: [
      { title: `Order — ${PRODUCT.guestFacingName}` },
      { name: "robots", content: "noindex,nofollow" },
      { name: "theme-color", content: "#346739" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "apple-mobile-web-app-title", content: PRODUCT.guestFacingName },
    ],
    links: [
      { rel: "manifest", href: "/lexibite-guest.webmanifest" },
      { rel: "apple-touch-icon", href: "/lexibite-guest-192.png" },
    ],
  }),
  component: OrderLanding,
});

function OrderLanding() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 pt-safe pb-safe text-center">
      <GuestServiceWorker />
      <span className="flex size-16 items-center justify-center rounded-full bg-primary/10">
        <UtensilsCrossed className="size-8 text-primary" aria-hidden />
      </span>
      <h1 className="font-display text-2xl text-foreground">Scan to order</h1>
      <p className="max-w-xs text-sm text-muted-foreground">
        {PRODUCT.guestFacingName} ordering is linked to your table. Scan the QR code on your table
        to open the menu.
      </p>
    </div>
  );
}
