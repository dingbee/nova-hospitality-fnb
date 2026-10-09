import { z } from "zod";

const uuid = z.string().uuid();

export const serviceRecoverySchema = z.object({
  tenantId: uuid,
  orderId: uuid,
  originalOrderItemId: uuid,
  replacementOrderItemId: uuid.optional(),
  refundPaymentId: uuid.optional(),
  clientRequestId: z.string().min(6).max(80),
  complaintCategory: z.enum([
    "wrong_item", "quality", "temperature", "delay", "allergy_safety",
    "guest_changed_mind", "missing_item", "other",
  ]),
  complaint: z.string().trim().min(3).max(2000),
  resolution: z.enum(["replace", "comp", "refund", "void_unprepared", "no_adjustment", "pending"]),
  resolutionReason: z.string().trim().min(3).max(1000),
  stockDisposition: z.enum(["preserve_consumption", "reverse_unprepared", "wastage_review", "not_applicable"]),
});
export type ServiceRecoveryInput = z.infer<typeof serviceRecoverySchema>;


export const serviceRecoveryResolutionSchema = z.object({
  tenantId: uuid,
  caseId: uuid,
  resolution: z.enum(["replace", "comp", "refund", "void_unprepared", "no_adjustment"]),
  reason: z.string().trim().min(3).max(1000),
  paymentId: uuid.optional(),
  amount: z.number().positive().optional(),
});
export type ServiceRecoveryResolutionInput = z.infer<typeof serviceRecoveryResolutionSchema>;
