import { createFileRoute } from "@tanstack/react-router";
import { createSocialGuestCommerceSessionFn } from "@/modules/restaurant/selforder/whatsapp-guest-portal.functions";
import { GuestCommerceEntry } from "@/modules/restaurant/selforder/GuestCommerceEntry";

export const Route = createFileRoute("/social/$tenantSlug/$propertySlug/$locationSlug")({
  loader: async ({ params }) =>
    createSocialGuestCommerceSessionFn({
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
  component: SocialGuestCommerceEntry,
});

function SocialGuestCommerceEntry() {
  const data = Route.useLoaderData();
  return <GuestCommerceEntry portalUrl={data.portalUrl} />;
}
