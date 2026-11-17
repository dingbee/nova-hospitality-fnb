import { z } from "zod";

/**
 * Guest order-progress lookup — table + order id only, exactly like every
 * other guest-facing contract in this module. Nothing about station,
 * ticket status, or production state is ever accepted from the client;
 * selftrack.server.ts re-derives all of it from the resolved table.
 */
export const guestOrderProgressSchema = z.object({
  tableId: z.string().uuid(),
  orderId: z.string().uuid(),
});
export type GuestOrderProgressInput = z.infer<typeof guestOrderProgressSchema>;
