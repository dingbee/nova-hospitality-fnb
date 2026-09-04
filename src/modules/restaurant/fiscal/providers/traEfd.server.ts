/**
 * TRA EFD/VFD production adapter — INTERFACE ONLY.
 *
 * This file exists so the production adapter slot in the Fiscal Core is
 * real, not a TODO. It intentionally does not implement a submission path:
 * no real TRA endpoint, authentication mechanism, request/response contract
 * or fiscal numbering rule has been provided, and none is invented here
 * (spec sections 2, 30, 46 — do not fabricate production TRA behavior).
 *
 * When approved TRA/VFD credentials and an integration contract are
 * available, implement submitReceipt() here following the same pattern as
 * the existing Pesapal adapter (selforder/providers/pesapal.server.ts):
 * credentials from server-only env vars, never a VITE_* one, never
 * committed, never logged, never returned to the browser.
 *
 * Required env vars (once a real contract exists — none of these are read
 * for any purpose today beyond isConfigured()):
 *   TRA_EFD_BASE_URL
 *   TRA_EFD_TIN
 *   TRA_EFD_API_KEY / TRA_EFD_CERTIFICATE — whatever the approved auth
 *     mechanism actually requires
 * Optional:
 *   TRA_EFD_ENV — "sandbox" (default) | "production"
 */
import type {
  FiscalConnectivityResult,
  FiscalProviderAdapter,
  FiscalSubmissionInput,
  FiscalSubmissionResult,
} from "../adapter";

function isConfigured(): boolean {
  return Boolean(process.env.TRA_EFD_BASE_URL && process.env.TRA_EFD_TIN);
}

/**
 * Returns null when unconfigured — exactly like createPesapalAdapter()
 * returning null with no consumer key set. The Fiscal Core must treat a
 * null adapter as "no production provider available" and put the fiscal
 * record into configuration_error, never fabricate a fiscalized outcome.
 */
export function createTraEfdAdapter(): FiscalProviderAdapter | null {
  if (!isConfigured()) return null;

  return {
    providerCode: "tra_efd",
    environment: "production",

    async verifyConnectivity(): Promise<FiscalConnectivityResult> {
      return {
        ok: false,
        detail: "TRA EFD adapter has no implemented submission contract yet.",
      };
    },

    async submitReceipt(_input: FiscalSubmissionInput): Promise<FiscalSubmissionResult> {
      return {
        outcome: "malformed_response",
        errorClass: "configuration",
        reason:
          "TRA EFD production submission is not implemented — no approved endpoint contract has been provided for this environment.",
      };
    },
  };
}
