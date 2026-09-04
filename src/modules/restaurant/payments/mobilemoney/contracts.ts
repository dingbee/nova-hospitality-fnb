/**
 * Mobile Money Payment Core — types, schemas and pure logic. Browser-safe:
 * no Supabase client, no adapter I/O. Mirrors restaurant_mobile_money_*
 * tables (standalone/db/migrations/0026_mobile_money_foundation.sql)
 * one-to-one.
 *
 * Product principle: "Enter Lipa Namba -> Activate -> ON." The operator
 * never sees provider/API complexity — that lives entirely behind:
 *
 *   LEXIBITE POS -> PAYMENT CORE -> MOBILE MONEY ADAPTER -> PSP / MNO
 */
import { z } from "zod";

export const MM_MODES = ["lipa_namba", "connected"] as const;
export type MobileMoneyMode = (typeof MM_MODES)[number];

export const MM_NETWORKS = ["mpesa", "mixx_yas", "airtel_money", "halopesa", "ttcl_pesa"] as const;
export type MobileMoneyNetwork = (typeof MM_NETWORKS)[number];

export const MM_NETWORK_LABELS: Record<MobileMoneyNetwork, string> = {
  mpesa: "M-Pesa",
  mixx_yas: "Mixx by YAS",
  airtel_money: "Airtel Money",
  halopesa: "HaloPesa",
  ttcl_pesa: "TTCL Pesa",
};

export const MM_ACTIVATION_STATES = ["inactive", "active"] as const;
export type MobileMoneyActivationState = (typeof MM_ACTIVATION_STATES)[number];

export const MM_ENVIRONMENTS = ["test", "production"] as const;
export type MobileMoneyEnvironment = (typeof MM_ENVIRONMENTS)[number];

/** One authoritative state per collection attempt. A successful request
 * means money was requested — never that money was received. */
export const MM_COLLECTION_STATES = [
  "created",
  "initiated",
  "pending_customer",
  "processing",
  "paid",
  "failed",
  "cancelled",
  "expired",
  "reversed",
  "refunded",
  "manual_confirmation_required",
] as const;
export type MobileMoneyCollectionState = (typeof MM_COLLECTION_STATES)[number];

export const MM_TERMINAL_STATES: readonly MobileMoneyCollectionState[] = [
  "paid",
  "cancelled",
  "reversed",
  "refunded",
];

export const MM_RETRYABLE_STATES: readonly MobileMoneyCollectionState[] = ["failed", "expired"];

export const MM_ERROR_CLASSES = [
  "configuration",
  "authentication",
  "validation",
  "provider_rejection",
  "network",
  "timeout",
  "duplicate",
  "customer_timeout",
  "wrong_amount",
  "unknown",
] as const;
export type MobileMoneyErrorClass = (typeof MM_ERROR_CLASSES)[number];

// ---------------------------------------------------------------------------
// Account configuration
// ---------------------------------------------------------------------------

export const upsertMobileMoneyAccountSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().optional().nullable(),
  locationId: z.string().uuid(),
  mode: z.enum(MM_MODES).default("lipa_namba"),
  network: z.enum(MM_NETWORKS),
  merchantNumber: z.string().trim().min(3).max(40),
  environment: z.enum(MM_ENVIRONMENTS).default("test"),
  activationState: z.enum(MM_ACTIVATION_STATES).default("inactive"),
});
export type UpsertMobileMoneyAccountInput = z.infer<typeof upsertMobileMoneyAccountSchema>;

export const getMobileMoneyAccountSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Collection request
// ---------------------------------------------------------------------------

export const requestMobileMoneyCollectionSchema = z.object({
  tenantId: z.string().uuid(),
  orderId: z.string().uuid(),
  amount: z.number().positive(),
  customerPhone: z.string().trim().max(20).optional().nullable(),
  /** Same key -> same collection. Generated once per "Request Payment" tap. */
  clientRequestId: z.string().min(6).max(80),
});
export type RequestMobileMoneyCollectionInput = z.infer<typeof requestMobileMoneyCollectionSchema>;

export const getMobileMoneyCollectionSchema = z.object({
  tenantId: z.string().uuid(),
  collectionId: z.string().uuid(),
});

export const listMobileMoneyCollectionsForOrderSchema = z.object({
  tenantId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export const confirmMobileMoneyCollectionSchema = z.object({
  tenantId: z.string().uuid(),
  collectionId: z.string().uuid(),
  providerReference: z.string().max(120).optional(),
});

export const cancelMobileMoneyCollectionSchema = z.object({
  tenantId: z.string().uuid(),
  collectionId: z.string().uuid(),
  reason: z.string().max(300).optional(),
});

export const reverseMobileMoneyCollectionSchema = z.object({
  tenantId: z.string().uuid(),
  collectionId: z.string().uuid(),
  amount: z.number().positive().optional(),
  reason: z.string().min(3).max(300),
});

export const listMobileMoneyReconciliationSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const getMobileMoneyHealthSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Status views — what POS/Settings render. Never technical detail.
// ---------------------------------------------------------------------------

export interface MobileMoneyStatusView {
  collectionId: string;
  state: MobileMoneyCollectionState;
  operatorMessage: string;
  amount: number;
  currency: string;
  mode: MobileMoneyMode;
  network: MobileMoneyNetwork;
  merchantNumber: string | null;
  customerPhone: string | null;
  requiresManualConfirmation: boolean;
}

/**
 * Operational language only — never provider name, API endpoint, OAuth,
 * webhook terminology or a raw provider error (spec sections 10/11/20/24).
 */
export function operatorMessageForCollectionState(
  state: MobileMoneyCollectionState,
  mode: MobileMoneyMode,
): string {
  switch (state) {
    case "created":
    case "initiated":
      return "Requesting payment…";
    case "pending_customer":
      return mode === "lipa_namba" ? "Waiting for payment" : "Waiting for customer confirmation…";
    case "processing":
      return "Confirming payment…";
    case "paid":
      return "Payment received";
    case "manual_confirmation_required":
      return "Awaiting confirmation";
    case "failed":
      return "Payment failed";
    case "cancelled":
      return "Payment request cancelled";
    case "expired":
      return "Payment request expired";
    case "reversed":
      return "Payment reversed";
    case "refunded":
      return "Payment refunded";
    default:
      return "Payment pending";
  }
}

export function isMobileMoneyTerminal(state: MobileMoneyCollectionState): boolean {
  return MM_TERMINAL_STATES.includes(state);
}

export function isMobileMoneyRetryable(state: MobileMoneyCollectionState): boolean {
  return MM_RETRYABLE_STATES.includes(state);
}

/** Health chip vocabulary — never a raw API error (spec section 20). */
export type MobileMoneyHealthStatus =
  "operational" | "configuration_required" | "connection_issue" | "provider_unavailable";

export function healthLabel(status: MobileMoneyHealthStatus): string {
  switch (status) {
    case "operational":
      return "Operational";
    case "configuration_required":
      return "Configuration required";
    case "connection_issue":
      return "Connection issue";
    case "provider_unavailable":
      return "Provider unavailable";
  }
}

/** Reconciliation Centre bucket for one collection — spec section 15. */
export type MobileMoneyReconciliationState =
  "matched" | "pending" | "failed" | "exception" | "reversed";

export function reconciliationStateForCollection(
  state: MobileMoneyCollectionState,
): MobileMoneyReconciliationState {
  switch (state) {
    case "paid":
      return "matched";
    case "created":
    case "initiated":
    case "pending_customer":
    case "processing":
    case "manual_confirmation_required":
      return "pending";
    case "failed":
    case "expired":
      return "failed";
    case "reversed":
    case "refunded":
      return "reversed";
    case "cancelled":
      return "exception";
    default:
      return "exception";
  }
}
