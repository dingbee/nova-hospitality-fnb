import { z } from "zod";

/**
 * Guest session-projection lookup — table id only, exactly like every other
 * guest-facing contract in this module. The active session (if any) and its
 * orders are entirely server-derived from the resolved table; nothing about
 * session identity, order membership, or totals is ever accepted from the
 * client.
 */
export const guestSessionProjectionSchema = z.object({
  tableId: z.string().uuid(),
});
export type GuestSessionProjectionInput = z.infer<typeof guestSessionProjectionSchema>;
