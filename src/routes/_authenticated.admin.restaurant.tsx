import { createFileRoute, Outlet } from "@tanstack/react-router";
// Declares Restaurant & Bar OS to the Intelligence Core registry (inert registration).
import "@/modules/restaurant/intelligence/provider";

export const Route = createFileRoute("/_authenticated/admin/restaurant")({
  head: () => ({
    meta: [
      { title: "Restaurant & Bar OS — NOVA Hospitality F&B" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: RestaurantLayout,
});

/**
 * Navigation for this section lives in the canonical NovaShell sidebar
 * (src/components/shell/navigation.ts). This layout only supplies the
 * route's page metadata; it does not render its own nav.
 */
function RestaurantLayout() {
  return <Outlet />;
}
