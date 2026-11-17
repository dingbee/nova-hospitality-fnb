/**
 * Guest self-order Mobile Money contracts — the merchant-number/Lipa Namba
 * mode of the SAME Payment Core POS uses (payments/mobilemoney), scoped by
 * table id exactly like selfpay.contracts.ts. Deliberately narrow: nothing
 * here accepts an amount, currency, or order state from the client — the
 * payable amount is always re-derived server-side (see mobilemoney.server.ts's
 * createCollectionForOrder).
 */
import { z } from "zod";

const uuid = z.string().uuid();

export const guestMobileMoneyAccountSchema = z.object({
  tableId: uuid,
});
export type GuestMobileMoneyAccountInput = z.infer<typeof guestMobileMoneyAccountSchema>;

export const requestGuestMobileMoneyCollectionSchema = z.object({
  tableId: uuid,
  orderId: uuid,
  customerPhone: z.string().trim().max(20).optional().nullable(),
  /** Same key -> same collection. Generated once per "Pay" tap. */
  clientRequestId: z.string().min(6).max(80),
});
export type RequestGuestMobileMoneyCollectionInput = z.infer<
  typeof requestGuestMobileMoneyCollectionSchema
>;

export const guestMobileMoneyStatusSchema = z.object({
  tableId: uuid,
  collectionId: uuid,
});
export type GuestMobileMoneyStatusInput = z.infer<typeof guestMobileMoneyStatusSchema>;
