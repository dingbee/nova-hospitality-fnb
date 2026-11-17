/**
 * Purchase order supplier-communication contracts and pure helpers.
 *
 * Mirrors receipts/delivery.types.ts exactly — same idempotency, attempt and
 * failure-code shape — reusing its email/phone helpers rather than
 * duplicating them. Sending a PO is a delivery attempt against an
 * already-authorized commercial document; it is never itself a governance
 * decision, so this module carries no PO status logic of its own.
 */
import { z } from "zod";
export {
  isValidEmail,
  normalizeEmail,
  normalizePhone,
  whatsAppShareUrl,
} from "../receipts/delivery.types";

export const PO_DELIVERY_METHODS = ["email", "whatsapp"] as const;
export type PoDeliveryMethod = (typeof PO_DELIVERY_METHODS)[number];

/** `shared` = a share surface was opened for staff; it is NOT provider delivery. */
export const PO_DELIVERY_STATUSES = ["pending", "sent", "delivered", "failed", "shared"] as const;
export type PoDeliveryStatus = (typeof PO_DELIVERY_STATUSES)[number];

export const PO_DELIVERY_FAILURE_CODES = [
  "invalid_email",
  "invalid_phone",
  "email_provider_not_configured",
  "whatsapp_provider_not_configured",
  "purchase_order_not_sendable",
  "supplier_missing",
  "provider_rejected",
  "network_timeout",
  "forbidden",
] as const;
export type PoDeliveryFailureCode = (typeof PO_DELIVERY_FAILURE_CODES)[number];

export const PO_DELIVERY_FAILURE_MESSAGES: Record<PoDeliveryFailureCode, string> = {
  invalid_email: "That email address is not valid. Check the spelling and try again.",
  invalid_phone:
    "That phone number is not valid. Use the international format, e.g. +255 712 345 678.",
  email_provider_not_configured: "Email sending is not configured for this property yet.",
  whatsapp_provider_not_configured:
    "WhatsApp Business sending is not configured — share the link instead.",
  purchase_order_not_sendable: "Only an approved purchase order can be sent to a supplier.",
  supplier_missing: "This purchase order has no supplier on file — add one before sending.",
  provider_rejected: "The delivery provider rejected the request.",
  network_timeout: "The delivery provider did not respond in time.",
  forbidden: "You do not have permission to send purchase orders for this restaurant.",
};

const uuid = z.string().uuid();

export const requestPoDeliverySchema = z.object({
  tenantId: uuid,
  purchaseOrderId: uuid,
  method: z.enum(PO_DELIVERY_METHODS),
  recipient: z.string().max(200).optional(),
  /** Stable per user intent; prevents double-click / retry duplicates. */
  idempotencyKey: z.string().min(6).max(120),
  correlationId: uuid.optional(),
});
export type RequestPoDeliveryInput = z.infer<typeof requestPoDeliverySchema>;

export const listPoDeliveriesSchema = z.object({
  tenantId: uuid,
  purchaseOrderId: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListPoDeliveriesInput = z.infer<typeof listPoDeliveriesSchema>;

/** Short summary for WhatsApp / the email's plain-text alternative — never recomputes money. */
export function buildPurchaseOrderMessage(input: {
  documentNumber: string;
  supplierName?: string | null;
  total: string;
  expectedAt?: string | null;
}): string {
  const lines = [
    `Purchase order ${input.documentNumber}${input.supplierName ? ` for ${input.supplierName}` : ""}.`,
    `Order total ${input.total}.`,
  ];
  if (input.expectedAt) lines.push(`Requested delivery: ${input.expectedAt}.`);
  lines.push("Full order details are attached below.");
  return lines.join("\n");
}

export interface PoDeliveryRecord {
  id: string;
  purchaseOrderId: string;
  documentNumber: string | null;
  method: PoDeliveryMethod;
  recipient: string | null;
  status: PoDeliveryStatus;
  provider: string | null;
  providerReference: string | null;
  failureCode: PoDeliveryFailureCode | null;
  failureReason: string | null;
  attempt: number;
  requestedAt: string;
  completedAt: string | null;
  duplicate?: boolean;
}
