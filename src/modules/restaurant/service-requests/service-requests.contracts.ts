import { z } from "zod";

export const acknowledgeServiceRequestSchema = z.object({
  tenantId: z.string().uuid(),
  requestId: z.string().uuid(),
});
export type AcknowledgeServiceRequestInput = z.infer<typeof acknowledgeServiceRequestSchema>;

export const resolveServiceRequestSchema = z.object({
  tenantId: z.string().uuid(),
  requestId: z.string().uuid(),
});
export type ResolveServiceRequestInput = z.infer<typeof resolveServiceRequestSchema>;
