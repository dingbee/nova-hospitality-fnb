import { createServerFn } from "@tanstack/react-start";
import {
  confirmGuestPaymentSchema,
  guestOrderStatusSchema,
  initiateGuestPaymentSchema,
} from "./selfpay.contracts";

/**
 * No requireSupabaseAuth — same reasoning as selforder.functions.ts. Scoped
 * by tableId + orderId (both unguessable uuids), never by identity. See
 * src/lib/rbac/authorization-gate.test.ts for the source-level checks that
 * hold this file to the same discipline as the rest of the guest surface.
 */
export const guestOrderStatusFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => guestOrderStatusSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfpay.server");
    return mod.guestOrderStatus(supabaseAdmin, data);
  });

export const initiateGuestPaymentFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => initiateGuestPaymentSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfpay.server");
    // Built server-side from a trusted base URL, never from client input —
    // this is the redirect Pesapal will send the guest's browser back to,
    // so it must not be an open redirect a request body could steer.
    const base = process.env.APP_BASE_URL ?? "";
    const returnUrl = `${base}/order/${data.tableId}?pay=return`;
    return mod.initiateGuestPayment(supabaseAdmin, data, returnUrl);
  });

/**
 * Called by the guest's own browser after Pesapal redirects it back to
 * order.$tableId.tsx with ?OrderTrackingId=... in the URL. That query
 * param is never trusted on its own — confirmGuestPayment re-verifies it
 * with Pesapal before anything is recorded. Safe to call more than once
 * (page refresh, back button): verify() is read-only and the eventual
 * payment insert is deduped on the provider reference.
 */
export const confirmGuestPaymentFn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => confirmGuestPaymentSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfpay.server");
    return mod.confirmGuestPaymentFromBrowser(supabaseAdmin, data);
  });

/**
 * Pesapal's own server-to-server IPN callback target. IMPORTANT — this is
 * NOT yet actually reachable by Pesapal: createServerFn endpoints use
 * TanStack Start's own RPC calling convention, not a plain HTTP GET/POST
 * with query-string params the way Pesapal's IPN mechanism calls a
 * registered URL. Shipping the verification LOGIC here (confirmPesapalCallback,
 * fully tested) is still correct and reusable, but wiring a genuinely
 * Pesapal-callable endpoint needs a plain HTTP route — this codebase's
 * installed TanStack Start version has no createServerFileRoute/equivalent,
 * and no Nitro server/api convention is wired into its build plugin either.
 * Until that route exists, the guest's own browser-return confirmation
 * (confirmGuestPaymentFn above) is the only path that actually marks an
 * order paid; a guest who never returns to the browser after paying will
 * not be reconciled automatically. See the final report's "remaining
 * blocker" for what adding a real route requires.
 */
export const pesapalIpnFn = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => {
    const raw = d as Record<string, unknown> | null | undefined;
    return {
      orderId: String(raw?.OrderMerchantReference ?? ""),
      providerReference: String(raw?.OrderTrackingId ?? ""),
    };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const mod = await import("./selfpay.server");
    return mod.confirmPesapalCallback(supabaseAdmin, data);
  });
