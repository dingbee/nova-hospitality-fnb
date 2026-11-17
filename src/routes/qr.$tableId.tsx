import { createFileRoute } from "@tanstack/react-router";
import { createQrGuestCommerceSessionFn } from "@/modules/restaurant/selforder/whatsapp-guest-portal.functions";
import { GuestCommerceEntry } from "@/modules/restaurant/selforder/GuestCommerceEntry";

export const Route = createFileRoute("/qr/$tableId")({
  loader: async ({ params }) => createQrGuestCommerceSessionFn({ data: { tableId: params.tableId } }),
  head: () => ({
    meta: [
      { title: "Table Menu — LexiBite" },
      { name: "robots", content: "noindex,nofollow" },
      { name: "referrer", content: "no-referrer" },
      { "http-equiv": "Cache-Control", content: "no-store, private, max-age=0" },
    ],
  }),
  component: () => {
    const data = Route.useLoaderData();
    return <GuestCommerceEntry portalUrl={data.portalUrl} />;
  },
});
