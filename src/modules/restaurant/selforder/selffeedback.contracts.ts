import { z } from "zod";

/**
 * Guest post-dining feedback — NOT
 * ../../intelligence/core/contracts.ts's submitFeedbackSchema (that rates
 * whether an AI recommendation/insight/prediction was useful). This rates
 * the dining experience itself, table + order scoped like every other
 * guest-facing contract in this module. Nothing about tenant/property/
 * location/payment state is ever accepted from the client.
 */
export const guestFeedbackStatusSchema = z.object({
  tableId: z.string().uuid(),
  orderId: z.string().uuid(),
});
export type GuestFeedbackStatusInput = z.infer<typeof guestFeedbackStatusSchema>;

export const submitGuestFeedbackSchema = z.object({
  tableId: z.string().uuid(),
  orderId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});
export type SubmitGuestFeedbackInput = z.infer<typeof submitGuestFeedbackSchema>;
