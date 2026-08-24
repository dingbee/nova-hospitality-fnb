/**
 * Pesapal's server-to-server IPN callback target — a Vercel Function, not a
 * TanStack Start route.
 *
 * Why this file exists here: TanStack Start's own file-route "Server
 * Routes" feature (`createFileRoute(...)({ server: { handlers } })`,
 * documented at tanstack.com/start/latest/docs/framework/react/guide/
 * server-routes) is NOT present in this repo's installed dependencies —
 * confirmed by inspecting the actual type declarations shipped in
 * node_modules/@tanstack/react-router@1.170.32 and
 * node_modules/@tanstack/router-core (no `server` field on route options
 * anywhere), and by the @tanstack/react-router changelog covering versions
 * 1.166.8 through 1.170.32 with zero mention of server routes. It is a
 * newer feature than what's installed here. createServerFn (used
 * everywhere else in this module) is TanStack's own RPC calling
 * convention — not something an external service like Pesapal, calling a
 * plain GET with query-string parameters, can address.
 *
 * Vercel Functions are a separate, framework-independent platform
 * mechanism: any file under /api at the project root exporting a Web
 * Standard fetch handler becomes a real HTTP endpoint with zero
 * configuration, deployed alongside whatever the rest of the app builds
 * to. It does not touch the TanStack Start/Nitro build in any way — Nitro
 * has no server/api convention wired into this project's build plugin
 * (@lovable.dev/vite-tanstack-config), so this directory is invisible to
 * it; Vercel's own build step is what serves this path.
 *   Docs: vercel.com/docs/functions/runtimes/node-js
 *
 * Endpoint: POST/GET /api/pesapal-ipn
 * Registered with Pesapal as PESAPAL_IPN_URL, e.g.
 * https://<production-domain>/api/pesapal-ipn
 *
 * Every query parameter here is untrusted input from the public internet.
 * Nothing is recorded as paid from anything this request claims — the
 * order id (OrderMerchantReference) only locates which order to check,
 * and confirmGuestPayment (shared with the guest's own browser-return
 * path — no second payment-recording mechanism) independently calls
 * Pesapal's own GetTransactionStatus before anything is written.
 */
import { confirmPesapalCallback } from "../src/modules/restaurant/selforder/selfpay.server";

/** The exact envelope Pesapal's IPN caller expects back — see developer.pesapal.com. Getting this wrong makes Pesapal retry indefinitely. */
function ipnResponse(orderTrackingId: string, orderMerchantReference: string, status: 200 | 500) {
  return new Response(
    JSON.stringify({
      orderNotificationType: "IPNCHANGE",
      orderTrackingId,
      orderMerchantReference,
      status,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const orderTrackingId = url.searchParams.get("OrderTrackingId") ?? "";
  const orderMerchantReference = url.searchParams.get("OrderMerchantReference") ?? "";

  // Malformed IPN: nothing to look up. Acknowledged, not processed — Pesapal
  // sending garbage isn't a transient failure worth retrying.
  if (!orderTrackingId || !orderMerchantReference) {
    return ipnResponse(orderTrackingId, orderMerchantReference, 200);
  }

  try {
    const { supabaseAdmin } = await import("../src/integrations/supabase/client.server");
    // Every outcome confirmPesapalCallback can return (paid, declined,
    // expired, pending, already_paid, provider_not_configured,
    // order_not_found) was successfully processed — none of them are a
    // reason for Pesapal to retry this callback.
    await confirmPesapalCallback(supabaseAdmin, {
      orderId: orderMerchantReference,
      providerReference: orderTrackingId,
    });
    return ipnResponse(orderTrackingId, orderMerchantReference, 200);
  } catch {
    // A real processing failure (Pesapal unreachable, a DB error) — worth
    // Pesapal retrying. Never leak the underlying error to a public caller.
    return ipnResponse(orderTrackingId, orderMerchantReference, 500);
  }
}
