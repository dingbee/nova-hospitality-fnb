import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  MobileMoneyAdapter,
  MobileMoneyCollectionInput,
  MobileMoneyCollectionResult,
  MobileMoneyHealthResult,
  MobileMoneyReversalResult,
  MobileMoneyStatusResult,
  MobileMoneyWebhookInput,
  MobileMoneyWebhookParseResult,
} from "../adapter";
import type { MobileMoneyProviderConfig, MobileMoneyProviderCredentials } from "../providerConnection.server";

const DEFAULT_SANDBOX = "https://api.sandbox.payin.co.tz/api/v1";
const DEFAULT_PRODUCTION = "https://api.payin.co.tz/api/v1";
const MAX_WEBHOOK_AGE_SECONDS = 300;

const NETWORK_MAP: Record<string, string> = {
  mpesa: "mpesa",
  airtel_money: "airtel",
  mixx_yas: "tigopesa",
  halopesa: "halopesa",
};

function normalizeTanzaniaPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("255")) return digits;
  if (digits.startsWith("0") && digits.length === 10) return "255" + digits.slice(1);
  if (digits.length === 9) return "255" + digits;
  return digits;
}

function baseUrl(environment: "test" | "production", config: MobileMoneyProviderConfig) {
  const configured = config.baseUrl?.trim();
  if (configured) {
    if (!configured.startsWith("https://")) {
      throw new Error("PayIn baseUrl must use HTTPS.");
    }
    return configured.replace(/\/$/, "");
  }
  return environment === "production" ? DEFAULT_PRODUCTION : DEFAULT_SANDBOX;
}

function headers(credentials: MobileMoneyProviderCredentials, idempotencyKey?: string) {
  if (!credentials.apiKey || !credentials.apiSecret) {
    throw new Error("PayIn API credentials are not configured.");
  }
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-API-Key": credentials.apiKey,
    "X-API-Secret": credentials.apiSecret,
    ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
  };
}

function errorClassForStatus(status: number): "authentication" | "validation" | "provider_rejection" | "network" | "timeout" | "duplicate" | "unknown" {
  if (status === 401 || status === 403) return "authentication";
  if (status === 422) return "validation";
  if (status === 409) return "duplicate";
  if (status === 408) return "timeout";
  if (status >= 500) return "network";
  return "provider_rejection";
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createPayInAdapter(
  environment: "test" | "production",
  credentials: MobileMoneyProviderCredentials,
  config: MobileMoneyProviderConfig = {},
): MobileMoneyAdapter {
  const root = baseUrl(environment, config);

  async function request(
    path: string,
    init: RequestInit,
  ): Promise<{ response: Response; body: any }> {
    try {
      const response = await fetch(root + path, {
        ...init,
        signal: AbortSignal.timeout(15000),
      });
      return { response, body: await readJson(response) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider request failed.";
      throw Object.assign(new Error(message), { code: "network" });
    }
  }

  return {
    providerCode: "payin",
    environment,
    automatic: true,

    async createCollection(
      input: MobileMoneyCollectionInput,
    ): Promise<MobileMoneyCollectionResult> {
      if (!input.customerPhone) {
        return {
          outcome: "rejected",
          errorClass: "validation",
          reason: "A customer mobile number is required for connected payment.",
        };
      }

      if (!Number.isInteger(input.amount) || input.amount < 100) {
        return {
          outcome: "rejected",
          errorClass: "validation",
          reason: "PayIn requires a whole-number amount of at least 100 TZS.",
        };
      }

      const operator = NETWORK_MAP[input.network];
      if (!operator) {
        return {
          outcome: "rejected",
          errorClass: "validation",
          reason: "The selected mobile-money network is not supported by this PayIn connector.",
        };
      }

      try {
        const { response, body } = await request("/collection", {
          method: "POST",
          headers: headers(credentials, input.idempotencyKey),
          body: JSON.stringify({
            phone: normalizeTanzaniaPhone(input.customerPhone),
            amount: input.amount,
            currency: input.currency,
            operator,
            reference: input.reference,
            description: "LexiBite restaurant payment",
            ...(config.callbackUrl ? { callback_url: config.callbackUrl } : {}),
          }),
        });

        if (!response.ok || !body?.request_ref) {
          return {
            outcome: "rejected",
            errorClass: errorClassForStatus(response.status),
            reason: String(body?.message ?? body?.error ?? "PayIn rejected the collection request."),
          };
        }

        return { outcome: "accepted", providerReference: String(body.request_ref) };
      } catch (error) {
        return {
          outcome: "rejected",
          errorClass: "network",
          reason: error instanceof Error ? error.message : "PayIn connection failed.",
        };
      }
    },

    async getPaymentStatus(providerReference: string): Promise<MobileMoneyStatusResult> {
      return this.verifyTransaction(providerReference);
    },

    async verifyTransaction(providerReference: string): Promise<MobileMoneyStatusResult> {
      try {
        const { response, body } = await request(
          "/status/" + encodeURIComponent(providerReference),
          { method: "GET", headers: headers(credentials) },
        );

        if (response.status === 404) return { outcome: "not_found" };
        if (!response.ok) {
          return {
            outcome: "failed",
            errorClass: errorClassForStatus(response.status),
            reason: String(body?.message ?? body?.error ?? "PayIn status lookup failed."),
          };
        }

        const status = String(body?.status ?? "").toLowerCase();
        if (status === "completed") {
          return {
            outcome: "paid",
            providerReference: String(body.request_ref ?? providerReference),
            confirmedAmount: Number(body.amount),
            confirmedCurrency: String(body.currency ?? "TZS"),
            paidAt: String(body.updated_at ?? body.created_at ?? new Date().toISOString()),
          };
        }
        if (["failed", "rejected", "expired"].includes(status)) {
          return {
            outcome: "failed",
            errorClass: status === "expired" ? "customer_timeout" : "provider_rejection",
            reason: String(body?.error ?? body?.reason ?? "Payment failed."),
          };
        }
        return { outcome: "pending" };
      } catch (error) {
        return {
          outcome: "failed",
          errorClass: "network",
          reason: error instanceof Error ? error.message : "PayIn status lookup failed.",
        };
      }
    },

    async handleWebhook(
      input: MobileMoneyWebhookInput,
    ): Promise<MobileMoneyWebhookParseResult> {
      let body: any;
      try {
        body = JSON.parse(input.rawBody);
      } catch {
        return { outcome: "invalid", reason: "Invalid JSON webhook payload." };
      }

      const providerReference = String(body?.request_ref ?? "");
      if (!providerReference) {
        return { outcome: "invalid", reason: "Webhook is missing request_ref." };
      }

      const signature = input.headers["x-payin-signature"] ?? input.headers["X-Payin-Signature"];
      const timestamp =
        input.headers["x-payin-timestamp"] ?? input.headers["X-Payin-Timestamp"];
      if (!signature || !timestamp || !credentials.webhookSecret) {
        return { outcome: "event", signatureValid: false, providerEventId: providerReference, providerReference, status: "pending" };
      }

      const timestampSeconds = Number(timestamp);
      if (!Number.isFinite(timestampSeconds)) {
        return { outcome: "event", signatureValid: false, providerEventId: providerReference, providerReference, status: "pending" };
      }

      if (Math.abs(Date.now() / 1000 - timestampSeconds) > MAX_WEBHOOK_AGE_SECONDS) {
        return { outcome: "event", signatureValid: false, providerEventId: providerReference, providerReference, status: "pending" };
      }

      const expected = createHmac("sha256", credentials.webhookSecret)
        .update(timestamp + "." + input.rawBody)
        .digest("hex");

      let valid = false;
      try {
        valid = timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
      } catch {
        valid = false;
      }

      const status = String(body?.status ?? "").toLowerCase();
      return {
        outcome: "event",
        signatureValid: valid,
        providerEventId:
          providerReference + ":" + String(body?.event ?? "unknown") + ":" + String(body?.timestamp ?? timestamp),
        providerReference,
        status:
          status === "completed" || body?.event === "payin.completed"
            ? "paid"
            : status === "failed" || body?.event === "payin.failed"
              ? "failed"
              : "pending",
        confirmedAmount:
          body?.gross_amount !== undefined ? Number(body.gross_amount) : undefined,
        confirmedCurrency: body?.currency ? String(body.currency) : undefined,
        reason: body?.reason ?? body?.error ?? undefined,
      };
    },

    async reversePayment(
      _providerReference: string,
      _amount: number,
    ): Promise<MobileMoneyReversalResult> {
      return {
        outcome: "unsupported",
        reason: "PayIn does not expose a certified collection reversal endpoint in the current connector contract.",
      };
    },

    async healthCheck(): Promise<MobileMoneyHealthResult> {
      try {
        const { response, body } = await request("/operators", {
          method: "GET",
          headers: headers(credentials),
        });
        return response.ok
          ? { ok: true, detail: String(body?.operators?.length ?? 0) + " operators reported." }
          : { ok: false, detail: "PayIn operator health check failed." };
      } catch {
        return { ok: false, detail: "PayIn connection failed." };
      }
    },
  };
}
