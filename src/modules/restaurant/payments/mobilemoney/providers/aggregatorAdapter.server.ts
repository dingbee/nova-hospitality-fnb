/**
 * Connected-mode Tanzania mobile money aggregator adapter — INTERFACE ONLY.
 *
 * V1 provider strategy (spec section 5): a unified Tanzanian aggregator is
 * the cleanest connected-mode route, since one API can in principle cover
 * M-Pesa, Mixx by YAS, Airtel Money, HaloPesa and TTCL Pesa rather than a
 * separate direct MNO integration per network. This file does not
 * implement that submission path: no real aggregator endpoint contract,
 * authentication mechanism or webhook signature scheme has been provided,
 * and none is invented here. Network support is a configuration/adapter
 * fact, never hard-coded into product logic (spec section 5) — see
 * contracts.ts's MM_NETWORKS, which this adapter would report through
 * healthCheck() once real capability data exists, not through product code
 * asserting "this aggregator supports M-Pesa".
 *
 * When approved commercial credentials and an integration contract exist,
 * implement createCollection/getPaymentStatus/handleWebhook/reversePayment
 * here following the same pattern as the existing Pesapal adapter
 * (selforder/providers/pesapal.server.ts) and the TRA EFD stub
 * (fiscal/providers/traEfd.server.ts): credentials from server-only env
 * vars, never a VITE_* one, never committed, never logged.
 *
 * Required env vars (once a real contract exists — none of these are read
 * for any purpose today beyond isConfigured()):
 *   MM_AGGREGATOR_BASE_URL
 *   MM_AGGREGATOR_API_KEY
 *   MM_AGGREGATOR_WEBHOOK_SECRET
 * Optional:
 *   MM_AGGREGATOR_ENV — "sandbox" (default) | "production"
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

function isConfigured(): boolean {
  return Boolean(process.env.MM_AGGREGATOR_BASE_URL && process.env.MM_AGGREGATOR_API_KEY);
}

/**
 * Returns null when unconfigured — exactly like createPesapalAdapter() and
 * createTraEfdAdapter() returning null with no credentials set. The
 * Payment Core must treat a null adapter as "no connected provider
 * available" and put the collection into a configuration error, never
 * fabricate an accepted/paid outcome.
 */
export function createAggregatorAdapter(): MobileMoneyAdapter | null {
  if (!isConfigured()) return null;

  return {
    providerCode: "tz_mm_aggregator",
    environment: process.env.MM_AGGREGATOR_ENV === "production" ? "production" : "test",
    automatic: true,

    async createCollection(
      _input: MobileMoneyCollectionInput,
    ): Promise<MobileMoneyCollectionResult> {
      return {
        outcome: "rejected",
        errorClass: "configuration",
        reason:
          "Connected mobile money submission is not implemented — no approved aggregator contract has been provided.",
      };
    },

    async getPaymentStatus(_providerReference: string): Promise<MobileMoneyStatusResult> {
      return { outcome: "not_found" };
    },

    async handleWebhook(_input: MobileMoneyWebhookInput): Promise<MobileMoneyWebhookParseResult> {
      return {
        outcome: "invalid",
        reason: "Connected aggregator webhook handling is not implemented.",
      };
    },

    async reversePayment(
      _providerReference: string,
      _amount: number,
    ): Promise<MobileMoneyReversalResult> {
      return {
        outcome: "unsupported",
        reason: "Connected aggregator reversal is not implemented.",
      };
    },

    async verifyTransaction(_providerReference: string): Promise<MobileMoneyStatusResult> {
      return { outcome: "not_found" };
    },

    async healthCheck(): Promise<MobileMoneyHealthResult> {
      return {
        ok: false,
        detail: "Connected aggregator adapter has no implemented submission contract yet.",
      };
    },
  };
}
