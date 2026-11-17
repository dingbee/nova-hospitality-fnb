/**
 * Fiscal domain — types, schemas and pure logic. Browser-safe: no Supabase
 * client, no adapter I/O. Mirrors the shape of restaurant_fiscal_* tables
 * (standalone/db/migrations/0025_fiscal_foundation.sql) one-to-one.
 *
 * LexiBite POS never talks to a fiscal provider directly:
 *
 *   LEXIBITE POS -> FISCAL CORE (fiscal.server.ts) -> FISCAL ADAPTER
 *     -> TRA / approved VFD provider -> FISCAL RESPONSE
 *     -> FISCAL RECORD (this module's tables) -> LEXIBITE RECEIPT
 */
import { z } from "zod";

export const FISCAL_ENVIRONMENTS = ["test", "production"] as const;
export type FiscalEnvironment = (typeof FISCAL_ENVIRONMENTS)[number];

export const FISCAL_ACTIVATION_STATES = ["inactive", "test", "active"] as const;
export type FiscalActivationState = (typeof FISCAL_ACTIVATION_STATES)[number];

/** One authoritative state per fiscal receipt. Never read two fields to decide status. */
export const FISCAL_STATES = [
  "not_required",
  "pending",
  "submitting",
  "accepted",
  "fiscalized",
  "rejected",
  "failed",
  "retry_required",
  "authentication_error",
  "configuration_error",
  "network_error",
] as const;
export type FiscalState = (typeof FISCAL_STATES)[number];

/** A fiscal receipt in one of these states has already been resolved — a
 * retry should never re-submit; it should read the existing record. */
export const FISCAL_TERMINAL_STATES: readonly FiscalState[] = [
  "fiscalized",
  "rejected",
  "not_required",
];

/** States where the operator can safely ask for another attempt. */
export const FISCAL_RETRYABLE_STATES: readonly FiscalState[] = [
  "failed",
  "retry_required",
  "network_error",
  "authentication_error",
  "configuration_error",
];

export const FISCAL_ERROR_CLASSES = [
  "configuration",
  "authentication",
  "validation",
  "provider_rejection",
  "network",
  "timeout",
  "duplicate",
  "unknown",
] as const;
export type FiscalErrorClass = (typeof FISCAL_ERROR_CLASSES)[number];

export const FISCAL_SUBMISSION_OUTCOMES = [
  "success",
  "rejected",
  "timeout",
  "network_error",
  "authentication_error",
  "malformed_response",
  "duplicate",
] as const;
export type FiscalSubmissionOutcome = (typeof FISCAL_SUBMISSION_OUTCOMES)[number];

export const FISCAL_Z_STATES = ["draft", "submitted", "acknowledged", "failed"] as const;
export type FiscalZState = (typeof FISCAL_Z_STATES)[number];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const upsertFiscalConfigurationSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().optional().nullable(),
  locationId: z.string().uuid(),
  businessName: z.string().min(1).max(200),
  tin: z.string().trim().max(40).optional().nullable(),
  vrn: z.string().trim().max(40).optional().nullable(),
  environment: z.enum(FISCAL_ENVIRONMENTS).default("test"),
  activationState: z.enum(FISCAL_ACTIVATION_STATES).default("inactive"),
  deviceSerial: z.string().trim().max(80).optional().nullable(),
  deviceUin: z.string().trim().max(80).optional().nullable(),
});
export type UpsertFiscalConfigurationInput = z.infer<typeof upsertFiscalConfigurationSchema>;

export const getFiscalConfigurationSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid(),
});

export const getFiscalStatusForOrderSchema = z.object({
  tenantId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export const listFiscalReceiptsSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const getFiscalHealthSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
});

export const prepareZReportDraftSchema = z.object({
  tenantId: z.string().uuid(),
  locationId: z.string().uuid(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "businessDate must be YYYY-MM-DD"),
});

export const requestFiscalizationSchema = z.object({
  tenantId: z.string().uuid(),
  orderId: z.string().uuid(),
  restaurantReceiptId: z.string().uuid().optional().nullable(),
});

// ---------------------------------------------------------------------------
// Fiscalization request / adapter payload
// ---------------------------------------------------------------------------

export interface FiscalReceiptLineInput {
  orderItemId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxClassificationCode: string | null;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
}

export interface FiscalizationRequest {
  tenantId: string;
  propertyId: string | null;
  locationId: string;
  orderId: string;
  restaurantReceiptId: string | null;
}

/** What the POS/receipt UI needs to show the operator — never the raw provider error. */
export interface FiscalStatusView {
  state: FiscalState;
  operatorMessage: string;
  fiscalReceiptNumber: string | null;
  verificationCode: string | null;
  zNumber: string | null;
  fiscalizedAt: string | null;
  environment: FiscalEnvironment | null;
}

/**
 * Operational language only — never HTTP status, provider name, endpoint,
 * certificate or auth mechanism detail (spec section 18/27/42).
 */
export function operatorMessageForState(state: FiscalState): string {
  switch (state) {
    case "not_required":
      return "Fiscal receipt not required for this outlet.";
    case "pending":
      return "Fiscal receipt pending.";
    case "submitting":
      return "Fiscalizing receipt…";
    case "accepted":
      return "Fiscal receipt accepted — finalising.";
    case "fiscalized":
      return "Fiscal receipt issued.";
    case "rejected":
      return "Fiscal receipt was rejected. Contact a manager.";
    case "retry_required":
    case "failed":
    case "network_error":
    case "authentication_error":
    case "configuration_error":
      return "Fiscal service unavailable — payment recorded, receipt pending. Retry required.";
    default:
      return "Fiscal receipt pending.";
  }
}

export function isFiscalTerminal(state: FiscalState): boolean {
  return FISCAL_TERMINAL_STATES.includes(state);
}

export function isFiscalRetryable(state: FiscalState): boolean {
  return FISCAL_RETRYABLE_STATES.includes(state);
}

/**
 * Deterministic idempotency key: one fiscal receipt per order, forever. The
 * DB's UNIQUE(tenant_id, order_id) constraint is the real enforcement point;
 * this key just makes concurrent callers converge on the same identity
 * instead of racing to create two rows.
 */
export function fiscalIdempotencyKey(orderId: string): string {
  return `fiscal:${orderId}`;
}
