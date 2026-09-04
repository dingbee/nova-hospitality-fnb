/**
 * Test/sandbox FiscalProviderAdapter (spec section 29).
 *
 * Simulates the outcomes the Fiscal Core must handle correctly:
 * SUCCESS, REJECTION, TIMEOUT, NETWORK_FAILURE, AUTHENTICATION_FAILURE,
 * DUPLICATE_SUBMISSION, MALFORMED_RESPONSE.
 *
 * This adapter never talks to TRA and never claims to. Every fiscal
 * receipt number it returns is prefixed TEST- so a fiscalized record
 * produced here can never be mistaken for a real TRA acknowledgement.
 */
import type {
  FiscalConnectivityResult,
  FiscalProviderAdapter,
  FiscalSubmissionInput,
  FiscalSubmissionResult,
} from "../adapter";

export type TestFiscalOutcomeMode =
  | "success"
  | "rejection"
  | "timeout"
  | "network_failure"
  | "authentication_failure"
  | "duplicate_submission"
  | "malformed_response";

export function createTestFiscalAdapter(
  mode: TestFiscalOutcomeMode = "success",
  opts: { existingFiscalReceiptNumber?: string } = {},
): FiscalProviderAdapter {
  return {
    providerCode: "test",
    environment: "test",

    async verifyConnectivity(): Promise<FiscalConnectivityResult> {
      return { ok: true, detail: "test adapter — always reachable" };
    },

    async submitReceipt(input: FiscalSubmissionInput): Promise<FiscalSubmissionResult> {
      switch (mode) {
        case "success": {
          const now = new Date().toISOString();
          const suffix = input.idempotencyKey
            .replace(/[^a-zA-Z0-9]/g, "")
            .slice(-10)
            .toUpperCase();
          return {
            outcome: "success",
            fiscalReceiptNumber: `TEST-${suffix}`,
            verificationCode: `VER-${suffix}`,
            zNumber: null,
            acknowledgedAt: now,
          };
        }
        case "rejection":
          return {
            outcome: "rejected",
            errorClass: "provider_rejection",
            reason:
              "Simulated rejection — receipt payload failed provider validation (test adapter).",
          };
        case "timeout":
          return {
            outcome: "timeout",
            errorClass: "timeout",
            reason: "Simulated timeout — provider did not respond in time (test adapter).",
          };
        case "network_failure":
          return {
            outcome: "network_error",
            errorClass: "network",
            reason: "Simulated network failure — connection to provider failed (test adapter).",
          };
        case "authentication_failure":
          return {
            outcome: "authentication_error",
            errorClass: "authentication",
            reason: "Simulated authentication failure — credentials rejected (test adapter).",
          };
        case "duplicate_submission":
          return {
            outcome: "duplicate",
            existingFiscalReceiptNumber: opts.existingFiscalReceiptNumber ?? null,
          };
        case "malformed_response":
          return {
            outcome: "malformed_response",
            errorClass: "unknown",
            reason:
              "Simulated malformed response — provider payload could not be parsed (test adapter).",
          };
        default:
          return {
            outcome: "malformed_response",
            errorClass: "unknown",
            reason: "Unknown simulated mode.",
          };
      }
    },
  };
}
