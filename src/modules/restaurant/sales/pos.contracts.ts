/**
 * POS transactional contracts.
 *
 * The POS is a *terminal* over the existing sales core — it adds no parallel
 * order model. These schemas describe what a till can send: a seat, a variant,
 * the modifiers a guest actually chose, and an idempotency key so a double-tap
 * on a touchscreen can never create a second order or a second charge.
 */
import { z } from "zod";
import { ORDER_TYPES, PAYMENT_STATES, tenantScopeSchema } from "../core/contracts";

const uuid = z.string().uuid();

export const POS_PAYMENT_METHODS = [
  "cash",
  "card",
  "mobile_money",
  "bank_transfer",
  "room_charge",
  "voucher",
  "comp",
] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];

/** A modifier exactly as the guest chose it, snapshotted onto the line. */
export const posModifierSchema = z.object({
  modifierId: uuid.optional(),
  groupId: uuid.optional(),
  name: z.string().min(1).max(120),
  priceDelta: z.number().default(0),
  quantity: z.number().min(0.001).max(99).default(1),
});
export type PosModifierInput = z.infer<typeof posModifierSchema>;

export const posLineSchema = z.object({
  menuItemId: uuid.optional(),
  variantId: uuid.optional(),
  stationId: uuid.optional(),
  description: z.string().min(1).max(200),
  quantity: z.number().min(0.001).max(999).default(1),
  unitPrice: z.number().min(0).default(0),
  discount: z.number().min(0).default(0),
  seatNumber: z.number().int().min(1).max(99).optional(),
  course: z.string().max(40).optional(),
  /** Printed on the kitchen ticket. */
  notes: z.string().max(500).optional(),
  /** Guest-facing preference, printed on the receipt, not the ticket. */
  guestNotes: z.string().max(500).optional(),
  modifiers: z.array(posModifierSchema).max(30).default([]),
});
export type PosLineInput = z.infer<typeof posLineSchema>;

export const openPosOrderSchema = tenantScopeSchema.extend({
  tableId: uuid.optional(),
  servicePeriodId: uuid.optional(),
  orderType: z.enum(ORDER_TYPES).default("dine_in"),
  guestCount: z.number().int().min(0).max(500).default(2),
  guestName: z.string().max(160).optional(),
  bookingId: uuid.optional(),
  currency: z.string().min(3).max(3).default("TZS"),
  terminalId: z.string().max(60).optional(),
  /** Same key ⇒ same order. Generated once per till interaction. */
  clientRequestId: z.string().min(6).max(80),
  lines: z.array(posLineSchema).default([]),
});
export type OpenPosOrderInput = z.infer<typeof openPosOrderSchema>;

export const addPosLinesSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  lines: z.array(posLineSchema).min(1),
});
export type AddPosLinesInput = z.infer<typeof addPosLinesSchema>;

export const voidPosLineSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  orderItemId: uuid,
  reason: z.string().min(3).max(300),
});
export type VoidPosLineInput = z.infer<typeof voidPosLineSchema>;

export const transferPosOrderSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  tableId: uuid.nullable().optional(),
  guestCount: z.number().int().min(0).max(500).optional(),
  reason: z.string().max(300).optional(),
});
export type TransferPosOrderInput = z.infer<typeof transferPosOrderSchema>;

export const posPaymentSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  clientRequestId: z.string().min(6).max(80),
  method: z.enum(POS_PAYMENT_METHODS).default("cash"),
  amount: z.number().min(0),
  tendered: z.number().min(0).optional(),
  reference: z.string().max(120).optional(),
  bookingId: uuid.optional(),
  state: z.enum(PAYMENT_STATES).default("paid"),
  /** Close the order automatically once it is fully settled. */
  closeWhenSettled: z.boolean().default(true),
});
export type PosPaymentInput = z.infer<typeof posPaymentSchema>;

export const reopenPosOrderSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  reason: z.string().min(3).max(300),
});
export type ReopenPosOrderInput = z.infer<typeof reopenPosOrderSchema>;

/** Whole-order cancellation. A reason is mandatory: cancellation is auditable. */
export const cancelOrderSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  reason: z.string().min(3).max(300),
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const posBoardSchema = tenantScopeSchema;
export const posCatalogSchema = tenantScopeSchema.extend({
  menuId: uuid.optional(),
});
export const posReceiptSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  reprint: z.boolean().default(false),
});