/**
 * LexiBite Demo Access — shared contracts.
 * Browser-safe: types + zod schemas only.
 */
import { z } from "zod";

export const registerDemoProspectSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  workEmail: z.string().trim().email().max(200),
  company: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(120),
  country: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).optional(),
  // Always LEXIBITE_DEMO in practice — accepted explicitly (and validated)
  // rather than silently ignored, so a caller sending the wrong source gets
  // a clear rejection instead of a silently mislabeled record.
  source: z.literal("LEXIBITE_DEMO").default("LEXIBITE_DEMO"),
});
export type RegisterDemoProspectInput = z.infer<typeof registerDemoProspectSchema>;

export const REGISTRATION_RESPONSE_STATES = [
  "verification_required",
  "already_registered",
  "error",
] as const;
export type RegistrationResponseState = (typeof REGISTRATION_RESPONSE_STATES)[number];

export interface RegisterDemoProspectResult {
  status: RegistrationResponseState;
  registrationId: string | null;
  message: string;
}

export const resendDemoVerificationSchema = z.object({
  workEmail: z.string().trim().email().max(200),
});
export type ResendDemoVerificationInput = z.infer<typeof resendDemoVerificationSchema>;

export const demoRegistrationStatusSchema = z.object({
  registrationId: z.string().uuid(),
});
