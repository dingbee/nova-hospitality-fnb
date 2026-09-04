/**
 * Mobile Money PSP/aggregator server-to-server webhook target — a Vercel
 * Function, not a TanStack Start route.
 *
 * Same reasoning as api/pesapal-ipn.ts (see that file's own header comment
 * for the full explanation): TanStack Start's file-route "Server Routes"
 * feature is not present in this repo's installed dependencies, and
 * createServerFn is an RPC calling convention a third-party PSP calling a
 * plain webhook POST cannot address. Vercel Functions are a separate,
 * framework-independent mechanism — any file under /api exporting a Web
 * Standard fetch handler becomes a real HTTP endpoint with zero
 * configuration.
 *
 * Endpoint: POST /api/mobile-money-webhook/:providerCode
 * Registered with the connected mobile money provider as its webhook/
 * callback URL, e.g. https://<production-domain>/api/mobile-money-webhook/tz_mm_aggregator
 *
 * Everything in this request is untrusted input from the public internet.
 * This handler does exactly one thing: hand the raw body/headers to
 * handleMobileMoneyWebhookEvent, which is idempotent by
 * (provider_code, provider_event_id), verifies the adapter-reported
 * signature, and — critically — never records a payment from what the
 * webhook itself claims. It re-verifies with the provider's own status
 * lookup first (mirrors confirmPesapalCallback/confirmGuestPayment's
 * "re-verify, don't trust" pattern). No payment-recording logic lives in
 * this file.
 */
function ok(): Response {
  // Acknowledge receipt regardless of processing outcome for a payload the
  // provider itself sent correctly — a business-logic outcome (duplicate,
  // collection not found, signature invalid) is not a transient failure
  // worth the provider retrying indefinitely.
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function failed(): Response {
  // A real processing failure (DB unreachable) — worth the provider
  // retrying. Never leak the underlying error to a public caller.
  return new Response(JSON.stringify({ received: false }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const providerCode = url.pathname.split("/").filter(Boolean).pop() || "unknown";
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  try {
    const { supabaseAdmin } = await import("../src/integrations/supabase/client.server");
    const { handleMobileMoneyWebhookEvent } =
      await import("../src/modules/restaurant/payments/mobilemoney/mobilemoney.server");
    // Every outcome handleMobileMoneyWebhookEvent can return (confirmed,
    // failed, duplicate, signature_invalid, collection_not_found,
    // no_provider_configured) was successfully processed — none of them
    // are a reason for the provider to retry this callback.
    await handleMobileMoneyWebhookEvent(supabaseAdmin, { providerCode, rawBody, headers });
    return ok();
  } catch {
    return failed();
  }
}
