/**
 * LB-01 cross-product integration contracts.
 *
 * Pure schemas only: no network, credentials, database access, or event publishing.
 * Keep byte-for-byte compatible with the other product's matching contract module.
 */
import { z } from "zod";

export const INTEGRATION_CONTRACT_VERSION = "1.0.0" as const;
export const INTEGRATION_PRODUCTS = ["staynas", "lexibite"] as const;
export const integrationProductSchema = z.enum(INTEGRATION_PRODUCTS);
export type IntegrationProduct = z.infer<typeof integrationProductSchema>;

const uuid = z.string().uuid();
// Z-only timestamps: cross-product event times are always UTC.
const isoUtc = z.string().datetime();

export const integrationTenantIdentitySchema = z.object({
  product: integrationProductSchema,
  nativeTenantId: uuid,
}).strict();

export const integrationPropertyIdentitySchema = z.object({
  product: integrationProductSchema,
  nativeTenantId: uuid,
  nativePropertyId: uuid,
}).strict();

export const integrationOutletIdentitySchema = z.object({
  product: z.literal("lexibite"),
  nativeTenantId: uuid,
  nativePropertyId: uuid,
  nativeOutletId: uuid,
}).strict();

export const propertyMappingProposalSchema = z.object({
  integrationTenantId: uuid,
  integrationPropertyId: uuid,
  source: integrationPropertyIdentitySchema,
  target: integrationPropertyIdentitySchema,
  status: z.enum(["pending", "active", "suspended", "revoked"]),
  requestedAt: isoUtc,
  correlationId: z.string().min(8).max(128),
}).strict().superRefine((mapping, ctx) => {
  if (mapping.source.product === mapping.target.product) {
    ctx.addIssue({ code: "custom", path: ["target", "product"], message: "A property mapping must connect two different products." });
  }
});

export const integrationConnectionStateSchema = z.enum([
  "pending", "active", "degraded", "suspended", "revoked",
]);
export type IntegrationConnectionState = z.infer<typeof integrationConnectionStateSchema>;

export const integrationConnectionDescriptorSchema = z.object({
  connectionId: uuid,
  integrationTenantId: uuid,
  localProduct: integrationProductSchema,
  remoteProduct: integrationProductSchema,
  state: integrationConnectionStateSchema,
  grantedCapabilities: z.array(z.string().regex(/^[a-z][a-z0-9_.:-]{1,79}$/)).max(100),
  createdAt: isoUtc,
  updatedAt: isoUtc,
  revokedAt: isoUtc.nullable(),
}).strict().superRefine((connection, ctx) => {
  if (connection.localProduct === connection.remoteProduct) {
    ctx.addIssue({ code: "custom", path: ["remoteProduct"], message: "A connection must identify a distinct remote product." });
  }
  if (connection.state === "revoked" && connection.revokedAt === null) {
    ctx.addIssue({ code: "custom", path: ["revokedAt"], message: "Revoked connections require a revocation timestamp." });
  }
});

export const INTEGRATION_EVENT_TYPES = [
  "property.created", "property.updated", "outlet.created", "outlet.updated",
  "guest.checked_in", "guest.checked_out", "guest.stay_status_changed", "folio.updated",
  "order.completed", "order.voided", "pos.transaction.completed", "inventory.updated",
] as const;
export const integrationEventTypeSchema = z.enum(INTEGRATION_EVENT_TYPES);

export const integrationEventEnvelopeSchema = z.object({
  eventId: uuid,
  eventType: integrationEventTypeSchema,
  eventVersion: z.number().int().positive(),
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  sourceProduct: integrationProductSchema,
  nativeTenantId: uuid,
  integrationPropertyId: uuid,
  aggregateId: uuid,
  occurredAt: isoUtc,
  publishedAt: isoUtc,
  correlationId: z.string().min(8).max(128),
  causationId: uuid.nullable(),
  idempotencyKey: z.string().min(8).max(200).nullable(),
  payload: z.record(z.string(), z.unknown()),
}).strict().superRefine((event, ctx) => {
  if (Date.parse(event.publishedAt) < Date.parse(event.occurredAt)) {
    ctx.addIssue({ code: "custom", path: ["publishedAt"], message: "Publication cannot precede occurrence." });
  }
});
export type IntegrationEventEnvelope = z.infer<typeof integrationEventEnvelopeSchema>;

export const financialOutcomeSchema = z.enum(["accepted", "rejected", "pending"]);
export const financialReferenceSchema = z.object({
  externalTransactionReference: z.string().min(1).max(160),
  idempotencyKey: z.string().min(8).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountMinor: z.number().int().nonnegative(),
  outcome: financialOutcomeSchema,
  reversalOf: z.string().min(1).max(160).nullable(),
  adjustmentOf: z.string().min(1).max(160).nullable(),
}).strict();

// LB-01 defines future financial semantics only. It does not post folios.
