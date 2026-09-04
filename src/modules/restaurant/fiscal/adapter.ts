/**
 * FiscalProviderAdapter — the one seam between the Fiscal Core and any actual
 * fiscal provider. Mirrors the existing PaymentProviderAdapter pattern
 * (selforder/selfpay.server.ts + selforder/providers/pesapal.server.ts):
 * the core depends on this interface only, never on a provider's SDK or
 * endpoint shape, so a second approved provider can be added without
 * touching POS or the Fiscal Core.
 *
 * Browser-safe (types only, no I/O) so it can be imported from contracts or
 * tests without pulling in server-only adapters.
 */
import type {
  FiscalEnvironment,
  FiscalErrorClass,
  FiscalReceiptLineInput,
  FiscalSubmissionOutcome,
} from "./contracts";

export interface FiscalSubmissionInput {
  environment: FiscalEnvironment;
  idempotencyKey: string;
  configuration: {
    businessName: string;
    tin: string | null;
    vrn: string | null;
    deviceSerial: string | null;
  };
  receipt: {
    currency: string;
    subtotal: number;
    taxTotal: number;
    total: number;
    issuedAt: string;
    paymentMethods: string[];
    items: FiscalReceiptLineInput[];
  };
}

export type FiscalSubmissionResult =
  | {
      outcome: "success";
      fiscalReceiptNumber: string;
      verificationCode: string | null;
      zNumber: string | null;
      acknowledgedAt: string;
    }
  | { outcome: "duplicate"; existingFiscalReceiptNumber: string | null }
  | {
      outcome: Exclude<FiscalSubmissionOutcome, "success" | "duplicate">;
      errorClass: FiscalErrorClass;
      reason: string;
    };

export interface FiscalConnectivityResult {
  ok: boolean;
  detail?: string;
}

export interface FiscalProviderAdapter {
  readonly providerCode: string;
  readonly environment: FiscalEnvironment;
  verifyConnectivity(): Promise<FiscalConnectivityResult>;
  submitReceipt(input: FiscalSubmissionInput): Promise<FiscalSubmissionResult>;
}
