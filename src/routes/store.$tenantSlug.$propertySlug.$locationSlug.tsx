import { createFileRoute } from "@tanstack/react-router";
import { createWebsiteGuestCommerceSessionFn } from "@/modules/restaurant/selforder/whatsapp-guest-portal.functions";
import { GuestCommerceEntry } from "@/modules/restaurant/selforder/GuestCommerceEntry";

export const Route = createFileRoute("/website/$tenantSlug/$propertySlug/$locationSlug")({
  loader: async ({ params }) =>
    createWebsiteGuestCommerceSessionFn({
      data: {
        tenantSlug: params.tenantSlug,
        propertySlug: params.propertySlug,
        locationSlug: params.locationSlug,
      },
    }),
  head: () => ({
    meta: [
      { title: "Restaurant Menu — LexiBite" },
      { name: "robots", content: "noindex,nofollow" },
      { name: "referrer", content: "no-referrer" },
      { "http-equiv": "Cache-Control", content: "no-store, private, max-age=0" },
    ],
  }),
  component: WebsiteGuestCommerceEntry,
});

function WebsiteGuestCommerceEntry() {
  const data = Route.useLoaderData();
  return <GuestCommerceEntry portalUrl={data.portalUrl} />;
}
