/**
 * Receipt delivery contracts and pure helpers.
 *
 * Delivery is deliberately separate from receipt issuance: the receipt is the
 * immutable financial document, delivery is an attempt to get a copy of it to
 * the guest. Attempts are append-only and never rewrite the receipt.
 */
import { z } from "zod";

export const DELIVERY_METHODS = ["print", "email", "whatsapp", "secure_link"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/** `shared` = a share surface was opened for staff; it is NOT provider delivery. */
export const DELIVERY_STATUSES = ["pending", "sent", "delivered", "failed", "shared"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_FAILURE_CODES = [
  "invalid_email",
  "invalid_phone",
  "email_provider_not_configured",
  "whatsapp_provider_not_configured",
  "receipt_unavailable",
  "provider_rejected",
  "network_timeout",
  "status_unknown",
  "forbidden",
] as const;
export type DeliveryFailureCode = (typeof DELIVERY_FAILURE_CODES)[number];

export const DELIVERY_FAILURE_MESSAGES: Record<DeliveryFailureCode, string> = {
  invalid_email: "That email address is not valid. Check the spelling and try again.",
  invalid_phone: "That phone number is not valid. Use the international format, e.g. +255 712 345 678.",
  email_provider_not_configured: "Email sending is not configured for this property yet.",
  whatsapp_provider_not_configured: "WhatsApp Business sending is not configured — share the link instead.",
  receipt_unavailable: "No issued receipt was found for this bill.",
  provider_rejected: "The delivery provider rejected the request.",
  network_timeout: "The delivery provider did not respond in time.",
  status_unknown: "The message was submitted but the provider did not confirm its status.",
  forbidden: "You do not have permission to deliver receipts for this restaurant.",
};

const uuid = z.string().uuid();

export const requestDeliverySchema = z.object({
  tenantId: uuid,
  receiptId: uuid.optional(),
  orderId: uuid.optional(),
  method: z.enum(DELIVERY_METHODS),
  recipient: z.string().max(200).optional(),
  /** Stable per user intent; prevents double-click / retry duplicates. */
  idempotencyKey: z.string().min(6).max(120),
  correlationId: uuid.optional(),
});
export type RequestDeliveryInput = z.infer<typeof requestDeliverySchema>;

export const listDeliveriesSchema = z.object({
  tenantId: uuid,
  receiptId: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListDeliveriesInput = z.infer<typeof listDeliveriesSchema>;

export const sharedReceiptSchema = z.object({ token: z.string().min(20).max(120) });

/* ------------------------------- pure helpers ------------------------------ */

const EMAIL_RE = /^[^\s@,;]+@[^\s@.,;]+(\.[^\s@.,;]+)+$/;

export function isValidEmail(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length > 0 && v.length <= 200 && EMAIL_RE.test(v);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalizes a Tanzanian or international phone number to E.164 digits.
 * Returns null when the number cannot be trusted; we never guess a country.
 */
export function normalizePhone(value: string | null | undefined, defaultCountry = "255"): string | null {
  if (!value) return null;
  const raw = value.trim();
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  const plus = digits.startsWith("+");
  digits = digits.replace(/\+/g, "");
  if (!plus) {
    if (digits.startsWith("0")) digits = `${defaultCountry}${digits.slice(1)}`;
    else if (digits.length <= 9) digits = `${defaultCountry}${digits}`;
  }
  if (digits.length < 9 || digits.length > 15) return null;
  return `+${digits}`;
}

export function whatsAppShareUrl(phone: string | null, message: string): string {
  const text = encodeURIComponent(message);
  return phone ? `https://wa.me/${phone.replace(/^\+/, "")}?text=${text}` : `https://wa.me/?text=${text}`;
}

export function buildReceiptMessage(input: {
  receiptNumber: string;
  outlet?: string | null;
  total: string;
  issuedAt?: string | null;
  link?: string | null;
}): string {
  const lines = [
    `Thank you for dining with us${input.outlet ? ` at ${input.outlet}` : ""}.`,
    `Receipt ${input.receiptNumber} — ${input.total} paid in full.`,
  ];
  if (input.issuedAt) lines.push(`Issued ${input.issuedAt.replace("T", " ").slice(0, 16)}.`);
  if (input.link) lines.push(`View your receipt: ${input.link}`);
  return lines.join("\n");
}

export interface DeliveryRecord {
  id: string;
  receiptId: string;
  receiptNumber: string | null;
  method: DeliveryMethod;
  recipient: string | null;
  status: DeliveryStatus;
  provider: string | null;
  providerReference: string | null;
  failureCode: DeliveryFailureCode | null;
  failureReason: string | null;
  attempt: number;
  requestedAt: string;
  completedAt: string | null;
  shareUrl?: string | null;
  duplicate?: boolean;
}