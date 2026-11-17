/* eslint-disable @typescript-eslint/no-explicit-any -- a simulated webhook body is untyped JSON at this boundary. */
/**
 * Test/sandbox connected-mode adapter (spec section 22).
 *
 * Simulates the outcomes the Payment Core must handle correctly: success,
 * pending, customer timeout, failed payment, provider timeout, network
 * failure, wrong amount, and reversal (success/unsupported). Never talks
 * to a real PSP. Every provider reference this returns is prefixed TEST-
 * so it can never be mistaken for a real transaction.
 *
 * Stateful like a real provider would be: createCollection remembers the
 * amount/currency it was asked to collect, keyed by its own generated
 * reference, so getPaymentStatus can report back what was "actually
 * collected" — exactly the shape a real PSP's status lookup has, and what
 * lets the Payment Core's own amount-reconciliation logic be exercised for
 * real rather than trusting a caller-supplied number.
 */
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

export type TestMobileMoneyMode =
  | "success"
  | "pending"
  | "customer_timeout"
  | "failed"
  | "provider_timeout"
  | "network_failure"
  | "wrong_amount"
  | "reversal_success"
  | "reversal_unsupported";

export function createTestMobileMoneyAdapter(
  mode: TestMobileMoneyMode = "success",
): MobileMoneyAdapter {
  const refFor = (key: string) =>
    `TEST-${key
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(-12)
      .toUpperCase()}`;
  const ledger = new Map<string, { amount: number; currency: string }>();

  const adapter: MobileMoneyAdapter = {
    providerCode: "test",
    environment: "test",
    automatic: true,

    async createCollection(
      input: MobileMoneyCollectionInput,
    ): Promise<MobileMoneyCollectionResult> {
      if (mode === "network_failure") {
        return {
          outcome: "rejected",
          errorClass: "network",
          reason: "Simulated network failure (test adapter).",
        };
      }
      if (mode === "provider_timeout") {
        return {
          outcome: "rejected",
          errorClass: "timeout",
          reason: "Simulated provider timeout (test adapter).",
        };
      }
      const providerReference = refFor(input.idempotencyKey);
      ledger.set(providerReference, { amount: input.amount, currency: input.currency });
      return { outcome: "accepted", providerReference };
    },

    async getPaymentStatus(providerReference: string): Promise<MobileMoneyStatusResult> {
      const recorded = ledger.get(providerReference);
      switch (mode) {
        case "success":
          if (!recorded) return { outcome: "not_found" };
          return {
            outcome: "paid",
            providerReference,
            confirmedAmount: recorded.amount,
            confirmedCurrency: recorded.currency,
            paidAt: new Date().toISOString(),
          };
        case "wrong_amount":
          if (!recorded) return { outcome: "not_found" };
          return {
            outcome: "paid",
            providerReference,
            // Deliberately different from what was requested.
            confirmedAmount: Number((recorded.amount * 0.5).toFixed(2)),
            confirmedCurrency: recorded.currency,
            paidAt: new Date().toISOString(),
          };
        case "pending":
          return { outcome: "pending" };
        case "customer_timeout":
          return {
            outcome: "failed",
            errorClass: "customer_timeout",
            reason: "Simulated customer timeout (test adapter).",
          };
        case "failed":
          return {
            outcome: "failed",
            errorClass: "provider_rejection",
            reason: "Simulated provider rejection (test adapter).",
          };
        default:
          return { outcome: "pending" };
      }
    },

    async handleWebhook(input: MobileMoneyWebhookInput): Promise<MobileMoneyWebhookParseResult> {
      let parsed: any;
      try {
        parsed = JSON.parse(input.rawBody);
      } catch {
        return { outcome: "invalid", reason: "Malformed test webhook payload." };
      }
      if (!parsed.providerEventId || !parsed.providerReference) {
        return { outcome: "invalid", reason: "Missing providerEventId/providerReference." };
      }
      return {
        outcome: "event",
        signatureValid: true,
        providerEventId: String(parsed.providerEventId),
        providerReference: String(parsed.providerReference),
        status:
          parsed.status === "failed" ? "failed" : parsed.status === "pending" ? "pending" : "paid",
        confirmedAmount: parsed.amount != null ? Number(parsed.amount) : undefined,
        confirmedCurrency: parsed.currency ?? undefined,
        reason: parsed.reason,
      };
    },

    async reversePayment(
      providerReference: string,
      _amount: number,
    ): Promise<MobileMoneyReversalResult> {
      if (mode === "reversal_unsupported") {
        return {
          outcome: "unsupported",
          reason: "Simulated provider without reversal support (test adapter).",
        };
      }
      return { outcome: "reversed", providerReference: `${providerReference}-REV` };
    },

    async verifyTransaction(providerReference: string): Promise<MobileMoneyStatusResult> {
      return adapter.getPaymentStatus(providerReference);
    },

    async healthCheck(): Promise<MobileMoneyHealthResult> {
      return { ok: mode !== "network_failure", detail: "test adapter" };
    },
  };

  return adapter;
}
