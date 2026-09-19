/**
 * P08 — API Access + Integration Platform: shared contracts.
 * Browser-safe: types + zod schemas only (imported by both admin
 * server-function input validators and the external router).
 */
import { z } from "zod";

const uuid = z.string().uuid();

/**
 * Fixed, closed scope vocabulary. A credential declares a subset of these;
 * nothing else is possible to request or grant — see
 * credentials.server.ts's serviceRoleForScopes for how each maps onto the
 * synthetic restaurant_members row's role ('viewer' vs 'api_service').
 */
export const API_SCOPES = ["locations:read", "menus:read", "orders:read", "orders:write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const WEBHOOK_EVENT_TYPES = [
  "order.created",
  "order.status_changed",
  "order.payment_recorded",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/* ---------------- API credentials ---------------- */

export const issueCredentialSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.nullish(),
  label: z.string().min(2).max(120),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
  expiresAt: z.string().datetime().nullish(),
});
export type IssueCredentialInput = z.infer<typeof issueCredentialSchema>;

export const listCredentialsSchema = z.object({ tenantId: uuid });

export const revokeCredentialSchema = z.object({
  tenantId: uuid,
  credentialId: uuid,
  reason: z.string().min(3).max(300),
});

/* ---------------- Integration registry ---------------- */

export const registerIntegrationSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.nullish(),
  provider: z.string().min(2).max(60),
  integrationType: z.string().min(2).max(60),
  label: z.string().min(2).max(120),
  config: z.record(z.string(), z.unknown()).default({}),
  secret: z.string().min(1).max(4000).optional(),
});
export type RegisterIntegrationInput = z.infer<typeof registerIntegrationSchema>;

export const updateIntegrationSchema = z.object({
  tenantId: uuid,
  integrationId: uuid,
  label: z.string().min(2).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).max(4000).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;

export const listIntegrationsSchema = z.object({ tenantId: uuid });

/* ---------------- Outbound webhooks ---------------- */

export const registerWebhookEndpointSchema = z.object({
  tenantId: uuid,
  propertyId: uuid.nullish(),
  integrationId: uuid.nullish(),
  url: z.string().url().startsWith("https://"),
  description: z.string().max(300).optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});
export type RegisterWebhookEndpointInput = z.infer<typeof registerWebhookEndpointSchema>;

export const updateWebhookEndpointSchema = z.object({
  tenantId: uuid,
  webhookEndpointId: uuid,
  status: z.enum(["active", "disabled"]).optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional(),
});

export const rotateWebhookSecretSchema = z.object({ tenantId: uuid, webhookEndpointId: uuid });

export const listWebhookDeliveriesSchema = z.object({
  tenantId: uuid,
  webhookEndpointId: uuid.optional(),
  status: z.enum(["pending", "in_flight", "delivered", "failed", "dead_letter"]).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const replayWebhookDeliverySchema = z.object({ tenantId: uuid, deliveryId: uuid });

/* ---------------- External /api/v1 request bodies ---------------- */
/** tenantId/propertyId are deliberately absent — always derived from the credential, never the client. */

// Query-string-driven schemas use z.coerce.number() — URLSearchParams
// values always arrive as strings.
export const apiListMenuItemsSchema = z.object({
  menuId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const apiPosLineSchema = z.object({
  menuItemId: uuid.optional(),
  description: z.string().min(1).max(200),
  quantity: z.number().min(0.001).max(999).default(1),
  unitPrice: z.number().min(0).default(0),
  course: z.string().max(40).optional(),
  notes: z.string().max(500).optional(),
});

// Mirrors src/modules/restaurant/core/contracts.ts's ORDER_TYPES/ORDER_STATUSES
// exactly (the canonical enums) — deliberately not re-exported from there
// since that file also carries tenantId/propertyId fields this API surface
// must never accept directly from a client (see the ADR's §13).
const API_ORDER_TYPES = [
  "dine_in",
  "bar",
  "takeaway",
  "room_service",
  "delivery",
  "banquet",
] as const;
const API_ORDER_STATUSES = ["open", "sent", "served", "closed", "cancelled", "voided"] as const;

export const apiCreateOrderSchema = z.object({
  tableId: uuid.optional(),
  orderType: z.enum(API_ORDER_TYPES).default("dine_in"),
  guestCount: z.number().int().min(0).max(500).default(2),
  guestName: z.string().max(160).optional(),
  currency: z.string().min(3).max(3).default("TZS"),
  lines: z.array(apiPosLineSchema).max(100).default([]),
});
export type ApiCreateOrderInput = z.infer<typeof apiCreateOrderSchema>;

export const apiListOrdersSchema = z.object({
  status: z.enum(API_ORDER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const apiTransitionOrderStatusSchema = z.object({
  status: z.enum(API_ORDER_STATUSES),
  reason: z.string().max(500).optional(),
});
