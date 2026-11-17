/**
 * MobileMoneyAdapter — the one seam between the Payment Core and any actual
 * PSP/MNO. Mirrors the existing PaymentProviderAdapter (Pesapal) and
 * FiscalProviderAdapter (TRA) patterns already in this codebase: the core
 * depends on this interface only, never on a provider's SDK, endpoint
 * shape or auth mechanism, so a second connected provider — or a direct
 * M-Pesa C2B adapter later — can be added without touching POS.
 *
 * Browser-safe (types only, no I/O).
 */
import type {
  MobileMoneyEnvironment,
  MobileMoneyErrorClass,
  MobileMoneyNetwork,
} from "./contracts";

export interface MobileMoneyCollectionInput {
  environment: MobileMoneyEnvironment;
  idempotencyKey: string;
  network: MobileMoneyNetwork;
  merchantNumber: string;
  customerPhone: string | null;
  amount: number;
  currency: string;
  reference: string;
}

export type MobileMoneyCollectionResult =
  | { outcome: "accepted"; providerReference: string }
  | { outcome: "rejected"; errorClass: MobileMoneyErrorClass; reason: string };

export type MobileMoneyStatusResult =
  | {
      outcome: "paid";
      providerReference: string;
      confirmedAmount: number;
      confirmedCurrency: string;
      paidAt: string;
    }
  | { outcome: "pending" }
  | { outcome: "failed"; errorClass: MobileMoneyErrorClass; reason: string }
  | { outcome: "not_found" };

export interface MobileMoneyWebhookInput {
  headers: Record<string, string>;
  rawBody: string;
}

export type MobileMoneyWebhookParseResult =
  | {
      outcome: "event";
      signatureValid: boolean;
      providerEventId: string;
      providerReference: string;
      status: "paid" | "failed" | "pending";
      confirmedAmount?: number;
      confirmedCurrency?: string;
      reason?: string;
    }
  | { outcome: "invalid"; reason: string };

export type MobileMoneyReversalResult =
  | { outcome: "reversed"; providerReference: string }
  | { outcome: "unsupported"; reason: string }
  | { outcome: "failed"; errorClass: MobileMoneyErrorClass; reason: string };

export interface MobileMoneyHealthResult {
  ok: boolean;
  detail?: string;
}

export interface MobileMoneyAdapter {
  readonly providerCode: string;
  readonly environment: MobileMoneyEnvironment;
  /** Whether this adapter auto-confirms (connected) or only records intent (lipa_namba). */
  readonly automatic: boolean;
  createCollection(input: MobileMoneyCollectionInput): Promise<MobileMoneyCollectionResult>;
  getPaymentStatus(providerReference: string): Promise<MobileMoneyStatusResult>;
  handleWebhook(input: MobileMoneyWebhookInput): Promise<MobileMoneyWebhookParseResult>;
  reversePayment(providerReference: string, amount: number): Promise<MobileMoneyReversalResult>;
  verifyTransaction(providerReference: string): Promise<MobileMoneyStatusResult>;
  healthCheck(): Promise<MobileMoneyHealthResult>;
}
