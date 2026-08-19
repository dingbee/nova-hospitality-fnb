import { z } from "zod";

const uuid = z.string().uuid();

export const folioStayLookupSchema = z.object({
  /** Room number, reservation reference or guest surname as typed at the till. */
  query: z.string().max(80).optional(),
  bookingId: uuid.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type FolioStayLookupInput = z.infer<typeof folioStayLookupSchema>;

export const folioValidateSchema = z.object({
  bookingId: uuid,
  amount: z.number(),
  currency: z.string().min(3).max(3),
});
export type FolioValidateInput = z.infer<typeof folioValidateSchema>;

export const folioPostSchema = z.object({
  bookingId: uuid,
  amount: z.number().positive(),
  currency: z.string().min(3).max(3),
  description: z.string().min(1).max(240),
  idempotencyKey: z.string().min(6).max(160),
  source: z
    .object({
      sourceSystem: z.string().max(60).default("restaurant_pos"),
      tenantId: uuid.optional(),
      propertyId: uuid.optional(),
      locationId: uuid.optional(),
      orderId: uuid.optional(),
      paymentId: uuid.optional(),
      correlationId: z.string().max(120).optional(),
    })
    .default({ sourceSystem: "restaurant_pos" }),
});
export type FolioPostInput = z.infer<typeof folioPostSchema>;

export const folioPostingStatusSchema = z.object({
  idempotencyKey: z.string().min(6).max(160).optional(),
  postingId: uuid.optional(),
  orderId: uuid.optional(),
});
export type FolioPostingStatusInput = z.infer<typeof folioPostingStatusSchema>;
