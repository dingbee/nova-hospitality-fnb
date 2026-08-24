/**
 * Self-order payment contracts.
 *
 * Deliberately narrow: nothing here accepts an amount, currency, discount,
 * tax, or payment/order status from the client. The payable amount is
 * always re-derived server-side from the order's own totals — see
 * selfpay.server.ts's initiateGuestPayment.
 */
import { z } from "zod";

const uuid = z.string().uuid();

export const guestOrderStatusSchema = z.object({
  tableId: uuid,
  orderId: uuid,
});
export type GuestOrderStatusInput = z.infer<typeof guestOrderStatusSchema>;

/**
 * Only methods a customer could plausibly complete unattended, on their own
 * device, through a real payment provider. Staff-only settlement paths
 * (cash, comp, room charge, bank transfer) are not reachable from here —
 * those still require a staff session and stay on the POS.
 */
export const GUEST_PAYMENT_METHODS = ["mobile_money", "card"] as const;

export const initiateGuestPaymentSchema = z.object({
  tableId: uuid,
  orderId: uuid,
  method: z.enum(GUEST_PAYMENT_METHODS),
});
export type InitiateGuestPaymentInput = z.infer<typeof initiateGuestPaymentSchema>;
