/**
 * Sprint 5.1 — Commercial Procurement Lifecycle contracts.
 *
 * Every stage of the lifecycle is a distinct concept with its own state:
 * need → request → approval → order → confirmation → receipt → variance →
 * inventory → invoice → match → payment. They are never collapsed into one
 * status field.
 */
import { z } from "zod";

const uuid = z.string().uuid();

/* ---------------- Lifecycle vocabularies ---------------- */

export const PR_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "converted_to_po",
  "cancelled",
] as const;
export type PurchaseRequestStatus = (typeof PR_STATUSES)[number];

export const PR_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type PurchaseRequestPriority = (typeof PR_PRIORITIES)[number];

export const CONFIRMATION_STATUSES = ["pending", "confirmed", "partially_confirmed", "declined"] as const;
export type SupplierConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export const RECEIPT_STATUSES = ["draft", "posted", "cancelled"] as const;
export type GoodsReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const INVOICE_STATUSES = ["draft", "recorded", "matched", "disputed", "cancelled"] as const;
export type SupplierInvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PROCUREMENT_PAYMENT_STATUSES = ["unpaid", "partially_paid", "paid", "disputed"] as const;
export type ProcurementPaymentStatus = (typeof PROCUREMENT_PAYMENT_STATUSES)[number];

export const VARIANCE_TYPES = ["quantity", "price", "quality", "delivery", "tax", "invoice"] as const;
export type VarianceType = (typeof VARIANCE_TYPES)[number];

export const VARIANCE_STATUSES = ["open", "accepted", "resolved", "escalated"] as const;
export type VarianceStatus = (typeof VARIANCE_STATUSES)[number];

export const PROCUREMENT_DOCUMENT_TYPES = [
  "purchase_request",
  "purchase_order",
  "supplier_confirmation",
  "goods_receipt",
  "supplier_invoice",
  "variance_report",
] as const;
export type ProcurementDocumentType = (typeof PROCUREMENT_DOCUMENT_TYPES)[number];

export const DOCUMENT_PREFIX: Record<ProcurementDocumentType, string> = {
  purchase_request: "PR",
  purchase_order: "PO",
  supplier_confirmation: "SC",
  goods_receipt: "GRN",
  supplier_invoice: "INV",
  variance_report: "VAR",
};

/* ---------------- Purchase requests ---------------- */

export const purchaseRequestLineSchema = z.object({
  id: uuid.optional(),
  inventoryItemId: uuid.optional(),
  unitId: uuid.optional(),
  preferredSupplierId: uuid.optional(),
  description: z.string().min(1).max(200),
  quantity: z.number().min(0),
  estimatedUnitCost: z.number().min(0).default(0),
  justification: z.string().max(500).optional(),
  recommendationRef: z.string().max(200).optional(),
});
export type PurchaseRequestLineInput = z.infer<typeof purchaseRequestLineSchema>;

export const listPurchaseRequestsSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  status: z.enum(PR_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const getPurchaseRequestSchema = z.object({ tenantId: uuid, id: uuid });

export const savePurchaseRequestSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  priority: z.enum(PR_PRIORITIES).default("normal"),
  category: z.string().max(60).optional(),
  reason: z.string().max(1000).optional(),
  notes: z.string().max(2000).optional(),
  currency: z.string().min(3).max(3).default("TZS"),
  requiredByDate: z.string().optional(),
  lines: z.array(purchaseRequestLineSchema).default([]),
});
export type SavePurchaseRequestInput = z.infer<typeof savePurchaseRequestSchema>;

export const transitionPurchaseRequestSchema = z.object({
  tenantId: uuid,
  id: uuid,
  action: z.enum(["submit", "approve", "reject", "cancel"]),
  reason: z.string().max(1000).optional(),
  /** Approver may trim requested quantities; keyed by request line id. */
  approvedQuantities: z.record(z.string(), z.number().min(0)).optional(),
});
export type TransitionPurchaseRequestInput = z.infer<typeof transitionPurchaseRequestSchema>;

export const convertRequestToOrderSchema = z.object({
  tenantId: uuid,
  requestId: uuid,
  supplierId: uuid,
  requestedDeliveryDate: z.string().optional(),
  paymentTerms: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
});
export type ConvertRequestToOrderInput = z.infer<typeof convertRequestToOrderSchema>;

/* ---------------- Approval rules ---------------- */

export const approvalRuleSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  documentType: z.enum(["purchase_request", "purchase_order"]).default("purchase_request"),
  category: z.string().max(60).optional(),
  currency: z.string().min(3).max(3).default("TZS"),
  minAmount: z.number().min(0).default(0),
  maxAmount: z.number().min(0).optional(),
  approverRoles: z.array(z.string().max(40)).min(1),
  requireSeparationOfDuties: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(100),
  active: z.boolean().default(true),
  notes: z.string().max(500).optional(),
});
export type ApprovalRuleInput = z.infer<typeof approvalRuleSchema>;

/* ---------------- Supplier confirmation ---------------- */

export const recordConfirmationSchema = z.object({
  tenantId: uuid,
  purchaseOrderId: uuid,
  supplierReference: z.string().max(120).optional(),
  status: z.enum(CONFIRMATION_STATUSES).default("confirmed"),
  confirmedDeliveryDate: z.string().optional(),
  notes: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        purchaseOrderItemId: uuid,
        confirmedQuantity: z.number().min(0),
        confirmedUnitPrice: z.number().min(0),
        confirmedDeliveryDate: z.string().optional(),
        notes: z.string().max(400).optional(),
      }),
    )
    .default([]),
});
export type RecordConfirmationInput = z.infer<typeof recordConfirmationSchema>;

/* ---------------- Goods receiving ---------------- */

export const receiptLineSchema = z.object({
  purchaseOrderItemId: uuid.optional(),
  inventoryItemId: uuid.optional(),
  unitId: uuid.optional(),
  storageLocationId: uuid.optional(),
  description: z.string().min(1).max(200),
  orderedQuantity: z.number().min(0).default(0),
  receivedQuantity: z.number().min(0),
  acceptedQuantity: z.number().min(0),
  rejectedQuantity: z.number().min(0).default(0),
  damagedQuantity: z.number().min(0).default(0),
  orderedUnitCost: z.number().min(0).default(0),
  unitCost: z.number().min(0),
  batchCode: z.string().max(80).optional(),
  expiryDate: z.string().optional(),
  rejectionReason: z.string().max(400).optional(),
  notes: z.string().max(400).optional(),
});
export type ReceiptLineInput = z.infer<typeof receiptLineSchema>;

export const createReceiptSchema = z.object({
  tenantId: uuid,
  purchaseOrderId: uuid.optional(),
  supplierId: uuid.optional(),
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  deliveryNoteRef: z.string().max(120).optional(),
  receivedAt: z.string().optional(),
  currency: z.string().min(3).max(3).default("TZS"),
  notes: z.string().max(2000).optional(),
  /** Post immediately: accepted quantities enter the stock ledger. */
  post: z.boolean().default(true),
  /**
   * Receiving more than was ordered is an authorised exception, never a
   * silent increase of the order. Required when any line over-delivers.
   */
  overReceiptReason: z.string().min(10).max(500).optional(),
  lines: z.array(receiptLineSchema).min(1),
});
export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;

export const listReceiptsSchema = z.object({
  tenantId: uuid,
  purchaseOrderId: uuid.optional(),
  status: z.enum(RECEIPT_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const getReceiptSchema = z.object({ tenantId: uuid, id: uuid });
export const postReceiptSchema = z.object({ tenantId: uuid, id: uuid });

/* ---------------- Variances ---------------- */

export const listVariancesSchema = z.object({
  tenantId: uuid,
  status: z.enum(VARIANCE_STATUSES).optional(),
  varianceType: z.enum(VARIANCE_TYPES).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

export const resolveVarianceSchema = z.object({
  tenantId: uuid,
  id: uuid,
  status: z.enum(["accepted", "resolved", "escalated"]),
  notes: z.string().max(1000).optional(),
});

/* ---------------- Supplier invoices ---------------- */

export const recordInvoiceSchema = z.object({
  tenantId: uuid,
  id: uuid.optional(),
  supplierId: uuid,
  purchaseOrderId: uuid.optional(),
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  supplierInvoiceNumber: z.string().min(1).max(80),
  invoiceDate: z.string(),
  dueDate: z.string().optional(),
  currency: z.string().min(3).max(3).default("TZS"),
  taxTotal: z.number().min(0).default(0),
  attachmentUrl: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        purchaseOrderItemId: uuid.optional(),
        receiptItemId: uuid.optional(),
        inventoryItemId: uuid.optional(),
        description: z.string().min(1).max(200),
        quantity: z.number().min(0),
        unitPrice: z.number().min(0),
        taxAmount: z.number().min(0).default(0),
      }),
    )
    .default([]),
});
export type RecordInvoiceInput = z.infer<typeof recordInvoiceSchema>;

export const listInvoicesSchema = z.object({
  tenantId: uuid,
  supplierId: uuid.optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  paymentStatus: z.enum(PROCUREMENT_PAYMENT_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const matchInvoiceSchema = z.object({ tenantId: uuid, invoiceId: uuid });

export const setInvoicePaymentStatusSchema = z.object({
  tenantId: uuid,
  invoiceId: uuid,
  paymentStatus: z.enum(PROCUREMENT_PAYMENT_STATUSES),
  amountPaid: z.number().min(0).optional(),
  reason: z.string().max(500).optional(),
});

/* ---------------- Price history & performance ---------------- */

export const listPriceHistorySchema = z.object({
  tenantId: uuid,
  supplierId: uuid.optional(),
  inventoryItemId: uuid.optional(),
  sinceDays: z.number().int().min(1).max(730).default(90),
  limit: z.number().int().min(1).max(500).default(200),
});

export const supplierPerformanceSchema = z.object({
  tenantId: uuid,
  sinceDays: z.number().int().min(1).max(730).default(90),
});

export const procurementOverviewSchema = z.object({ tenantId: uuid });

export const listAuditSchema = z.object({
  tenantId: uuid,
  documentType: z.enum(PROCUREMENT_DOCUMENT_TYPES).optional(),
  documentId: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
