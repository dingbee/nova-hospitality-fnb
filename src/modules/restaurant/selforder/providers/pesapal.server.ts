/* eslint-disable @typescript-eslint/no-explicit-any -- Pesapal's own JSON responses are untyped at this boundary. */
/**
 * Pesapal API 3.0 adapter. Credentials and environment are injected from the
 * tenant/property-scoped encrypted integration registry; this module never
 * reads global PESAPAL_* environment variables and never falls back between
 * tenants or properties.
 */
import type { PaymentProviderAdapter } from "../selfpay.server";
import { logServerFailure } from "@/lib/observability/log.server";

const SANDBOX_BASE = "https://cybqa.pesapal.com/pesapalv3";
const PRODUCTION_BASE = "https://pay.pesapal.com/v3";
const PESAPAL_REQUEST_TIMEOUT_MS = 20_000;

export type PesapalAdapterConfig = {
  consumerKey: string;
  consumerSecret: string;
  environment: "sandbox" | "production";
  ipnUrl?: string;
  ipnId?: string;
  onIpnRegistered?: (ipnId: string) => Promise<void>;
};

type TokenCache = { token: string; expiresAt: number } | null;

function validConfig(config: PesapalAdapterConfig | null | undefined): config is PesapalAdapterConfig {
  return Boolean(
    config?.consumerKey.trim() &&
      config.consumerSecret.trim() &&
      ["sandbox", "production"].includes(config.environment) &&
      (config.ipnId?.trim() || config.ipnUrl?.startsWith("https://")),
  );
}

export function createPesapalAdapter(
  config: PesapalAdapterConfig | null | undefined,
): PaymentProviderAdapter | null {
  if (!validConfig(config)) return null;

  const baseUrl = config.environment === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
  let tokenCache: TokenCache = null;
  let ipnIdCache: string | null = config.ipnId?.trim() || null;

  async function pesapalFetch(path: string, init: RequestInit & { auth?: boolean } = {}) {
    const { auth = true, headers, signal, ...rest } = init;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), PESAPAL_REQUEST_TIMEOUT_MS);
    const onExternalAbort = () => timeoutController.abort();
    signal?.addEventListener("abort", onExternalAbort);
    try {
      const token = auth ? await getToken(timeoutController.signal) : undefined;
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          ...rest,
          signal: timeoutController.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
          },
        });
      } catch (err) {
        const reason = (err as Error)?.name === "AbortError" ? "timeout" : "network";
        logServerFailure("integration:pesapal", null, { operation: path, reason }, err);
        throw err;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.error) {
        const message =
          body?.error?.message ??
          body?.message ??
          `Pesapal request to ${path} failed (${res.status}).`;
        logServerFailure(
          "integration:pesapal",
          null,
          { operation: path, status: res.status },
          message,
        );
        throw new Error(message);
      }
      return body as any;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async function getToken(signal?: AbortSignal | null): Promise<string> {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 15_000) return tokenCache.token;
    const body = await pesapalFetch("/api/Auth/RequestToken", {
      method: "POST",
      auth: false,
      signal,
      body: JSON.stringify({
        consumer_key: config.consumerKey,
        consumer_secret: config.consumerSecret,
      }),
    });
    if (!body.token) throw new Error("Pesapal did not return an auth token.");
    const expiresAt = body.expiryDate ? new Date(body.expiryDate).getTime() : Date.now() + 4 * 60_000;
    tokenCache = { token: body.token, expiresAt };
    return body.token;
  }

  async function ensureIpnId(signal?: AbortSignal): Promise<string> {
    if (ipnIdCache) return ipnIdCache;
    if (!config.ipnUrl) {
      throw new Error("This property’s Pesapal integration has no registered IPN URL or IPN ID.");
    }
    const body = await pesapalFetch("/api/URLSetup/RegisterIPN", {
      method: "POST",
      signal,
      body: JSON.stringify({ url: config.ipnUrl, ipn_notification_type: "GET" }),
    });
    if (!body.ipn_id) throw new Error("Pesapal did not return an ipn_id when registering the IPN URL.");
    ipnIdCache = String(body.ipn_id);
    await config.onIpnRegistered?.(ipnIdCache);
    return ipnIdCache;
  }

  function mapStatus(body: any): "paid" | "failed" | "pending" | "expired" {
    const code = Number(body.status_code);
    const description = String(body.payment_status_description ?? "").toLowerCase();
    if (code === 1 || description === "completed") return "paid";
    if (description === "expired") return "expired";
    if (code === 2 || description === "failed" || description === "invalid") return "failed";
    return "pending";
  }

  return {
    name: "pesapal",

    async testConnection() {
      await getToken();
    },

    async initiate({ amount, currency, merchantReference, description, returnUrl, signal }) {
      const notificationId = await ensureIpnId(signal);
      const body = await pesapalFetch("/api/Transactions/SubmitOrderRequest", {
        method: "POST",
        signal,
        body: JSON.stringify({
          id: merchantReference,
          currency,
          amount,
          description: description.slice(0, 100),
          callback_url: returnUrl,
          notification_id: notificationId,
          billing_address: {
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
      const status = mapStatus(body);
      if (status === "paid") {
        return { status: "paid", amount: Number(body.amount), currency: String(body.currency) };
      }
      return { status, failureReason: body.payment_status_description };
    },
  };
}
