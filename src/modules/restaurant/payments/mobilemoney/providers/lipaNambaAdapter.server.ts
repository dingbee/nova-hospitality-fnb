/**
 * Lipa Namba / merchant-number adapter — Mode A, the ultra-simple mode.
 *
 * This adapter never calls an external API. "createCollection" only
 * records the operator's intent to be paid at this merchant number; it
 * NEVER auto-confirms (spec section 3 — must not falsely claim automatic
 * payment confirmation). Confirmation only ever happens through the
 * verified/manual "Mark as received" workflow, which is a Payment Core
 * action (mobilemoney.server.ts's confirmCollection), not something this
 * adapter can do to itself.
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

export function createLipaNambaAdapter(): MobileMoneyAdapter {
  return {
    providerCode: "lipa_namba",
    environment: "test",
    automatic: false,

    async createCollection(
      input: MobileMoneyCollectionInput,
    ): Promise<MobileMoneyCollectionResult> {
      // No provider call — the "reference" is just this request's own
      // idempotency key, so the collection has something stable to trace.
      return { outcome: "accepted", providerReference: `LIPA-${input.idempotencyKey}` };
    },

    async getPaymentStatus(_providerReference: string): Promise<MobileMoneyStatusResult> {
      // There is nothing to poll — a human confirms this mode, never the adapter.
      return { outcome: "pending" };
    },

    async handleWebhook(_input: MobileMoneyWebhookInput): Promise<MobileMoneyWebhookParseResult> {
      return { outcome: "invalid", reason: "Lipa Namba mode has no provider webhook." };
    },

    async reversePayment(
      _providerReference: string,
      _amount: number,
    ): Promise<MobileMoneyReversalResult> {
      return {
        outcome: "unsupported",
        reason: "Merchant-number mode has no automatic reversal — refund manually.",
      };
    },

    async verifyTransaction(_providerReference: string): Promise<MobileMoneyStatusResult> {
      return { outcome: "pending" };
    },

    async healthCheck(): Promise<MobileMoneyHealthResult> {
      return { ok: true, detail: "Lipa Namba mode — manual confirmation, no external dependency." };
    },
  };
}
