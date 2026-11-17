/**
 * Phase 2 — POS / sales ingestion contracts.
 *
 * Declared now so integrators can build against a stable shape. No tables and
 * no runtime behaviour exist yet; Phase 1 ships the foundation only.
 */
import { z } from "zod";

export const salesLineSchema = z.object({
  menuItemId: z.string().uuid().optional(),
  sku: z.string().max(60).optional(),
  description: z.string().max(200),
  quantity: z.number().min(0),
  unitPrice: z.number().min(0),
  discount: z.number().min(0).default(0),
  taxAmount: z.number().min(0).default(0),
});

/** A closed POS ticket, normalised across providers (Square, Lightspeed, custom). */
export const salesTicketSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  externalId: z.string().max(120),
  provider: z.string().max(60).default("manual"),
  openedAt: z.string().datetime().optional(),
  closedAt: z.string().datetime(),
  currency: z.string().min(3).max(3),
  covers: z.number().int().min(0).default(0),
  serviceCharge: z.number().min(0).default(0),
  taxTotal: z.number().min(0).default(0),
  total: z.number().min(0),
  /** Optional link back to a lodge reservation for room-charge posting. */
  bookingId: z.string().uuid().optional(),
  lines: z.array(salesLineSchema).default([]),
});
export type SalesTicketInput = z.infer<typeof salesTicketSchema>;