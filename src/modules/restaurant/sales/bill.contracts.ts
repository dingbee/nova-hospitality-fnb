/**
 * Bill → Payment → Receipt → Settlement contracts.
 *
 * The bill is never a second source of truth: these schemas only describe what
 * a till may *ask* for. Every amount that matters is recomputed server-side
 * from the order lines that were actually sold.
 */
import { z } from "zod";

const uuid = z.string().uuid();

export const RECEIPT_DELIVERY_CHANNELS = ["print", "email", "whatsapp", "none"] as const;
export type ReceiptDeliveryChannel = (typeof RECEIPT_DELIVERY_CHANNELS)[number];

export const SPLIT_MODES = ["none", "seat", "even", "amount"] as const;
export type BillSplitMode = (typeof SPLIT_MODES)[number];

export const getBillSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  splitMode: z.enum(SPLIT_MODES).default("none"),
  /** Number of even shares when splitting evenly. */
  ways: z.number().int().min(2).max(24).default(2),
});
export type GetBillInput = z.infer<typeof getBillSchema>;

export const billStageSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  note: z.string().max(300).optional(),
});
export type BillStageInput = z.infer<typeof billStageSchema>;

export const releaseTableSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
});

export const refundPaymentSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  paymentId: uuid,
  amount: z.number().min(0.01),
  reason: z.string().min(3).max(300),
  clientRequestId: z.string().min(6).max(80),
});
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;

export const deliverReceiptSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  channel: z.enum(RECEIPT_DELIVERY_CHANNELS),
  to: z.string().max(200).optional(),
});
export type DeliverReceiptInput = z.infer<typeof deliverReceiptSchema>;

export const listReceiptsSchema = z.object({
  tenantId: uuid,
  query: z.string().max(80).default(""),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListReceiptsInput = z.infer<typeof listReceiptsSchema>;