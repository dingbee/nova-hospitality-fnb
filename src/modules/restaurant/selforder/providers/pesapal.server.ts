/* eslint-disable @typescript-eslint/no-explicit-any -- Pesapal's own JSON responses are untyped at this boundary. */
/**
 * Pesapal API 3.0 adapter, behind selfpay.server.ts's PaymentProviderAdapter
 * interface. Verified against the current API 3.0 (JSON) documentation at
 * developer.pesapal.com as of this writing:
 *   - Authentication:        /how-to-integrate/e-commerce/api-30-json/authentication
 *   - SubmitOrderRequest:    /how-to-integrate/e-commerce/api-30-json/submitorderrequest
 *   - GetTransactionStatus:  /how-to-integrate/e-commerce/api-30-json/gettransactionstatus
 *   - RegisterIPN:           /how-to-integrate/e-commerce/api-30-json/registeripnurl
 *
 * All credentials are read from server-only environment variables (never a
 * VITE_* one, so nothing here can end up in a browser bundle) and this file
 * is only ever imported from other .server.ts modules.
 *
 * Required env vars:
 *   PESAPAL_CONSUMER_KEY     — merchant consumer key
 *   PESAPAL_CONSUMER_SECRET  — merchant consumer secret
 *   PESAPAL_IPN_URL          — the server-to-server callback URL to register with Pesapal
 * Optional:
 *   PESAPAL_ENV      — "sandbox" (default) | "production"
 *   PESAPAL_IPN_ID   — a already-registered IPN id, to skip re-registering on every cold start
 */
import type { PaymentProviderAdapter } from "../selfpay.server";

const SANDBOX_BASE = "https://cybqa.pesapal.com/pesapalv3";
const PRODUCTION_BASE = "https://pay.pesapal.com/v3";

function baseUrl(): string {
  return process.env.PESAPAL_ENV === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
}

function isConfigured(): boolean {
  return Boolean(process.env.PESAPAL_CONSUMER_KEY && process.env.PESAPAL_CONSUMER_SECRET);
}

type TokenCache = { token: string; expiresAt: number } | null;
let tokenCache: TokenCache = null;
let ipnIdCache: string | null = null;

async function pesapalFetch(path: string, init: RequestInit & { auth?: boolean } = {}) {
  const { auth = true, headers, ...rest } = init;
  const token = auth ? await getToken() : undefined;
  const res = await fetch(`${baseUrl()}${path}`, {
    ...rest,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    const message =
      body?.error?.message ?? body?.message ?? `Pesapal request to ${path} failed (${res.status}).`;
    throw new Error(message);
  }
  return body as any;
}

/** Cached for its ~5 minute lifetime; refreshed a little early to avoid a request racing expiry. */
async function getToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 15_000) return tokenCache.token;
  const body = await pesapalFetch("/api/Auth/RequestToken", {
    method: "POST",
    auth: false,
    body: JSON.stringify({
      consumer_key: process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
    }),
  });
  if (!body.token) throw new Error("Pesapal did not return an auth token.");
  // expiryDate is provider-supplied when present; otherwise assume the documented 5-minute lifetime.
  const expiresAt = body.expiryDate ? new Date(body.expiryDate).getTime() : Date.now() + 4 * 60_000;
  tokenCache = { token: body.token, expiresAt };
  return body.token;
}

/**
 * SubmitOrderRequest requires a registered IPN id on every call. A
 * PESAPAL_IPN_ID env var (set once, from the Pesapal merchant dashboard or
 * a prior registration) is preferred in production — it avoids registering
 * a fresh IPN subscription on every cold start. Falling back to
 * self-registration keeps this adapter usable without that extra step.
 */
async function ensureIpnId(): Promise<string> {
  if (process.env.PESAPAL_IPN_ID) return process.env.PESAPAL_IPN_ID;
  if (ipnIdCache) return ipnIdCache;
  if (!process.env.PESAPAL_IPN_URL) {
    throw new Error(
      "PESAPAL_IPN_URL is not configured — required to register an IPN before submitting an order.",
    );
  }
  const body = await pesapalFetch("/api/URLSetup/RegisterIPN", {
    method: "POST",
    body: JSON.stringify({
      url: process.env.PESAPAL_IPN_URL,
      ipn_notification_type: "GET",
    }),
  });
  if (!body.ipn_id)
    throw new Error("Pesapal did not return an ipn_id when registering the IPN URL.");
  ipnIdCache = body.ipn_id;
  return body.ipn_id;
}

/** Pesapal's own status vocabulary (status_code / payment_status_description), mapped onto the adapter's own. */
function mapStatus(body: any): "paid" | "failed" | "pending" | "expired" {
  const code = Number(body.status_code);
  const description = String(body.payment_status_description ?? "").toLowerCase();
  if (code === 1 || description === "completed") return "paid";
  if (description === "expired") return "expired";
  if (code === 2 || description === "failed" || description === "invalid") return "failed";
  return "pending";
}

export function createPesapalAdapter(): PaymentProviderAdapter | null {
  if (!isConfigured()) return null;

  return {
    name: "pesapal",

    async initiate({ amount, currency, merchantReference, description, returnUrl }) {
      const notificationId = await ensureIpnId();
      const body = await pesapalFetch("/api/Transactions/SubmitOrderRequest", {
        method: "POST",
        body: JSON.stringify({
          id: merchantReference,
          currency,
          amount,
          description: description.slice(0, 100),
          callback_url: returnUrl,
          notification_id: notificationId,
          billing_address: {
            // Left blank when the guest hasn't supplied contact details —
            // Pesapal's own hosted page collects what it still needs before
            // completing the payment.
            email_address: "",
            phone_number: "",
            country_code: "TZ",
          },
        }),
      });
      if (!body.order_tracking_id || !body.redirect_url) {
        throw new Error(
          body.error?.message ?? "Pesapal did not return a redirect URL for this order.",
        );
      }
      return { providerReference: body.order_tracking_id, redirectUrl: body.redirect_url };
    },

    async verify({ providerReference }) {
      const body = await pesapalFetch(
        `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(providerReference)}`,
        { method: "GET" },
      );
      return { status: mapStatus(body), failureReason: body.payment_status_description };
    },
  };
}
