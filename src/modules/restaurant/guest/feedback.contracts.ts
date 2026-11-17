import { z } from "zod";

export const guestFeedbackSummarySchema = z.object({
  tenantId: z.string().uuid(),
  windowDays: z.number().int().min(7).max(120).default(30),
});
export type GuestFeedbackSummaryInput = z.infer<typeof guestFeedbackSummarySchema>;
