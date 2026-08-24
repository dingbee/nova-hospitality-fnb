/**
 * Customer self-ordering contracts.
 *
 * A guest is identified by nothing but the table they scanned — there is no
 * login, no tenant/property/location in the request body. Every line reuses
 * the till's own `posModifierSchema`/quantity limits so a guest cart is
 * shaped exactly like a POS cart; only the identity model differs.
 */
import { z } from "zod";
import { posLineSchema } from "../sales/pos.contracts";

const uuid = z.string().uuid();

export const guestMenuSchema = z.object({
  tableId: uuid,
});
export type GuestMenuInput = z.infer<typeof guestMenuSchema>;

/** Station/seat are never meaningful from a guest — the server ignores them regardless. */
export const guestLineSchema = posLineSchema.omit({ stationId: true, seatNumber: true });
export type GuestLineInput = z.infer<typeof guestLineSchema>;

export const submitGuestOrderSchema = z.object({
  tableId: uuid,
  guestName: z.string().max(160).optional(),
  lines: z.array(guestLineSchema).min(1).max(50),
});
export type SubmitGuestOrderInput = z.infer<typeof submitGuestOrderSchema>;
