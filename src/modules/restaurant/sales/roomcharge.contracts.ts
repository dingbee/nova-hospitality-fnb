import { z } from "zod";

const uuid = z.string().uuid();

export const roomChargeSearchSchema = z.object({
  tenantId: uuid,
  query: z.string().max(80).optional(),
});
export type RoomChargeSearchInput = z.infer<typeof roomChargeSearchSchema>;

export const roomChargeQuoteSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  bookingId: uuid,
  amount: z.number().positive(),
});
export type RoomChargeQuoteInput = z.infer<typeof roomChargeQuoteSchema>;

export const roomChargeCommitSchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  bookingId: uuid,
  amount: z.number().positive(),
  /** Same key ⇒ same folio posting *and* same outlet payment row. */
  clientRequestId: z.string().min(6).max(80),
  closeWhenSettled: z.boolean().default(true),
});
export type RoomChargeCommitInput = z.infer<typeof roomChargeCommitSchema>;
