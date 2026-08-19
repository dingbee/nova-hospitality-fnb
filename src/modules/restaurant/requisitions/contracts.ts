/**
 * Kitchen / Bar / Department Requisition contracts (Sprint 5.5) — browser-safe.
 *
 * A requisition is a department's request for stock from a store: it moves
 * through draft → submitted → approved → (partially_issued | fulfilled), with
 * rejected/cancelled terminal branches. Issuing always moves stock through the
 * ledger (source → destination); nothing here writes a balance directly.
 */
import { z } from "zod";

const uuid = z.string().uuid();

export const REQUISITION_KINDS = ["kitchen", "bar", "department"] as const;
export type RequisitionKind = (typeof REQUISITION_KINDS)[number];

export const REQUISITION_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "partially_issued",
  "fulfilled",
  "rejected",
  "cancelled",
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

export function requisitionPrefix(kind: RequisitionKind): string {
  if (kind === "kitchen") return "REQ-KIT";
  if (kind === "bar") return "REQ-BAR";
  return "REQ-DEP";
}

export function requisitionBadge(status: string): { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" } {
  switch (status) {
    case "draft":
      return { label: "Draft", tone: "neutral" };
    case "submitted":
      return { label: "Submitted", tone: "warning" };
    case "approved":
      return { label: "Approved", tone: "info" };
    case "partially_issued":
      return { label: "Partially issued", tone: "warning" };
    case "fulfilled":
      return { label: "Fulfilled", tone: "success" };
    case "rejected":
      return { label: "Rejected", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "danger" };
    default:
      return { label: status, tone: "neutral" };
  }
}

const requisitionLineInput = z.object({
  id: uuid.optional(),
  inventoryItemId: uuid,
  unitId: uuid.optional(),
  description: z.string().max(500).optional(),
  requestedQuantity: z.number().min(0.0001),
  notes: z.string().max(500).optional(),
});
export type RequisitionLineInput = z.infer<typeof requisitionLineInput>;

export const listRequisitionsSchema = z.object({
  tenantId: uuid,
  status: z.enum(REQUISITION_STATUSES).optional(),
  kind: z.enum(REQUISITION_KINDS).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const getRequisitionSchema = z.object({
  tenantId: uuid,
  id: uuid,
});

export const saveRequisitionDraftSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  id: uuid.optional(),
  kind: z.enum(REQUISITION_KINDS),
  department: z.string().max(120).optional(),
  sourceLocationId: uuid,
  destinationLocationId: uuid,
  requiredDate: z.string().optional(),
  notes: z.string().max(2000).optional(),
  submit: z.boolean().default(false),
  lines: z.array(requisitionLineInput).min(1),
});
export type SaveRequisitionDraftInput = z.infer<typeof saveRequisitionDraftSchema>;

export const submitRequisitionSchema = z.object({
  tenantId: uuid,
  requisitionId: uuid,
});

export const approveRequisitionSchema = z.object({
  tenantId: uuid,
  requisitionId: uuid,
  lines: z.array(z.object({ lineId: uuid, approvedQuantity: z.number().min(0) })).min(1),
});
export type ApproveRequisitionInput = z.infer<typeof approveRequisitionSchema>;

export const rejectRequisitionSchema = z.object({
  tenantId: uuid,
  requisitionId: uuid,
  reason: z.string().min(2).max(500),
});

export const cancelRequisitionSchema = z.object({
  tenantId: uuid,
  requisitionId: uuid,
  reason: z.string().max(500).optional(),
});

export const issueRequisitionSchema = z.object({
  tenantId: uuid,
  requisitionId: uuid,
  lines: z.array(z.object({ lineId: uuid, issueQuantity: z.number().min(0) })).min(1),
});
export type IssueRequisitionInput = z.infer<typeof issueRequisitionSchema>;
