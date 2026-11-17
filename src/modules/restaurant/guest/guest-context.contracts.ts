import { z } from "zod";
import { GUEST_CONTEXT_KINDS, GUEST_CONTEXT_STATES } from "./dietary";

const uuid = z.string().uuid();

export const guestContextSchema = z.object({
  tenantId: uuid,
  guestId: uuid.optional(),
  bookingId: uuid.optional(),
  orderId: uuid.optional(),
});
export type GuestContextInput = z.infer<typeof guestContextSchema>;

export const recordGuestContextSchema = z.object({
  tenantId: uuid,
  guestId: uuid,
  kind: z.enum(GUEST_CONTEXT_KINDS),
  key: z.string().min(1).max(80),
  value: z.string().min(1).max(300),
  severity: z.enum(["mild", "severe", "critical"]).nullish(),
  /** Staff confirmation turns an observation into confirmed context. */
  confirmed: z.boolean().default(false),
  source: z.string().max(60).default("restaurant-service"),
});
export type RecordGuestContextInput = z.infer<typeof recordGuestContextSchema>;

export const captureStatementSchema = z.object({
  tenantId: uuid,
  guestId: uuid,
  statement: z.string().min(4).max(400),
});
export type CaptureStatementInput = z.infer<typeof captureStatementSchema>;

export const guestStateSchema = z.enum(GUEST_CONTEXT_STATES);