import { z } from "zod";
export const setPosPinSchema = z.object({
  tenantId: z.string().uuid(),
  memberId: z.string().uuid(),
  pin: z.string().regex(/^\d{4,6}$/, "PIN must contain 4 to 6 digits"),
});
export const clearPosPinSchema = z.object({
  tenantId: z.string().uuid(),
  memberId: z.string().uuid(),
});
export const startPosSessionSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid(),
  pin: z.string().regex(/^\d{4,6}$/, "PIN must contain 4 to 6 digits"),
  terminalId: z.string().max(60).optional(),
});
export const endPosSessionSchema = z.object({ sessionId: z.string().uuid() });
