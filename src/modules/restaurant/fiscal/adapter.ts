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

/**
 * Numbering allocated by the Fiscal Core (fiscal.server.ts) before the
 * adapter is ever called — GC/DC/ZNUM concurrency-safety and freeze-on-retry
 * is the Core's responsibility (spec section 5), not any one provider's.
 * The internal test adapter ignores this entirely; the real TRA adapter
 * requires it to build a receipt at all.
 */
export interface FiscalNumbering {
  gc: number;
  dc: number;
  znum: string;
  rctDate: string;
  rctTime: string;
  /** Set once known (first attempt) so a retry can report the same identity without rebuilding. */
  rctvnum?: string;
}

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
    /** Per-payment amounts — needed by a real provider's PAYMENTS section (paymentMethods alone has no amounts). */
    payments: Array<{ method: string; amount: number }>;
    items: FiscalReceiptLineInput[];
  };
  /** Present only when a real numbered submission is possible (TRA path). */
  numbering?: FiscalNumbering | null;
  /** TRA-issued registration identity — REGID/EFDSERIAL/RECEIPTCODE. */
  registration?: { regId: string; efdSerial: string; receiptCode: string } | null;
  /** A valid, already-refreshed TRA access token — the adapter never fetches its own. */
  accessToken?: string | null;
  /**
   * The exact signed XML from a prior attempt on this same fiscal receipt.
   * When present, a real provider MUST resend these exact bytes rather than
   * rebuild anything — this is the retry-preserves-original-payload rule
   * (spec section 5/9/22).
   */
  existingSignedXml?: string | null;
}

export type FiscalSubmissionResult =
  | {
      outcome: "success";
      fiscalReceiptNumber: string;
      verificationCode: string | null;
      zNumber: string | null;
      acknowledgedAt: string;
      /** The exact bytes sent/signed — persisted verbatim for future retries/audit. */
      signedXml?: string;
      rctvnum?: string;
      ackCode?: string;
      ackMessage?: string;
    }
  | { outcome: "duplicate"; existingFiscalReceiptNumber: string | null }
  | {
      outcome: Exclude<FiscalSubmissionOutcome, "success" | "duplicate">;
      errorClass: FiscalErrorClass;
      reason: string;
      signedXml?: string;
      ackCode?: string;
      ackMessage?: string;
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
