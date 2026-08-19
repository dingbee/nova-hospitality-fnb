/**
 * Sprint 5.12 — reconciliation contracts (browser-safe).
 *
 * A close is scoped to a tenant, a business date and optionally one location:
 * a group closes each outlet's drawer separately even though the day is shared.
 */
import { z } from "zod";
import { EXCEPTION_CODES, EXCEPTION_STATUSES, RECONCILIATION_DOMAINS } from "./catalogue";

const uuid = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const CLOSE_STATUSES = ["draft", "declared", "reconciled", "closed", "reopened"] as const;
export type CloseStatus = (typeof CLOSE_STATUSES)[number];

export const RECONCILIATION_SCOPES = ["full", "cash", "payment", "sales", "inventory", "procurement"] as const;
export type ReconciliationScope = (typeof RECONCILIATION_SCOPES)[number];

export const openDailyCloseSchema = z.object({
  tenantId: uuid,
  locationId: uuid.optional(),
  businessDate,
  openingFloat: z.number().min(0).default(0),
  currency: z.string().min(1).max(8).default("TZS"),
});

export const getDailyCloseSchema = z.object({
  tenantId: uuid,
  locationId: uuid.optional(),
  businessDate,
});

export const listDailyClosesSchema = z.object({
  tenantId: uuid,
  limit: z.number().int().min(1).max(200).default(30),
});

export const declareTendersSchema = z.object({
  tenantId: uuid,
  closeId: uuid,
  notes: z.string().max(2000).optional(),
  declarations: z
    .array(
      z.object({
        method: z.string().min(1).max(40),
        declaredAmount: z.number(),
        notes: z.string().max(500).optional(),
      }),
    )
    .min(1),
});

export const runReconciliationSchema = z.object({
  tenantId: uuid,
  locationId: uuid.optional(),
  businessDate,
  scope: z.enum(RECONCILIATION_SCOPES).default("full"),
});

/**
 * Closing is a control gate, not a formality: unresolved critical/high
 * exceptions block it unless an authorised user overrides with a reason.
 */
export const closeDaySchema = z.object({
  tenantId: uuid,
  closeId: uuid,
  notes: z.string().max(2000).optional(),
  overrideReason: z.string().min(10).max(500).optional(),
});

export const reopenDaySchema = z.object({
  tenantId: uuid,
  closeId: uuid,
  reason: z.string().min(10).max(500),
});

export const listExceptionsSchema = z.object({
  tenantId: uuid,
  businessDate: businessDate.optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  domain: z.enum(RECONCILIATION_DOMAINS).optional(),
  status: z.enum(EXCEPTION_STATUSES).optional(),
  code: z.enum(EXCEPTION_CODES).optional(),
  onlyOpen: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
});

export const resolveExceptionSchema = z.object({
  tenantId: uuid,
  exceptionId: uuid,
  status: z.enum(["reviewing", "resolved", "accepted", "dismissed"]),
  resolution: z.string().max(120).optional(),
  note: z.string().min(5).max(2000),
});

export const exceptionTrendSchema = z.object({
  tenantId: uuid,
  days: z.number().int().min(7).max(180).default(30),
});

export const listReconciliationAuditSchema = z.object({
  tenantId: uuid,
  subjectId: uuid.optional(),
  limit: z.number().int().min(1).max(300).default(100),
});

export type OpenDailyCloseInput = z.infer<typeof openDailyCloseSchema>;
export type DeclareTendersInput = z.infer<typeof declareTendersSchema>;
export type RunReconciliationInput = z.infer<typeof runReconciliationSchema>;
export type CloseDayInput = z.infer<typeof closeDaySchema>;
export type ReopenDayInput = z.infer<typeof reopenDaySchema>;
export type ListExceptionsInput = z.infer<typeof listExceptionsSchema>;
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;

export const CLOSE_STATUS_LABELS: Record<CloseStatus, string> = {
  draft: "Open",
  declared: "Declared",
  reconciled: "Reconciled",
  closed: "Closed",
  reopened: "Reopened",
};