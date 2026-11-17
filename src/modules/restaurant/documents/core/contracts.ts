/**
 * RPC contracts for the document layer. Browser-safe.
 */
import { z } from "zod";
import { DOCUMENT_TYPE_IDS } from "./registry";

const uuid = z.string().uuid();

export const documentTypeEnum = z.enum(DOCUMENT_TYPE_IDS);
export const documentFormatEnum = z.enum(["print", "pdf", "csv", "xlsx", "json"]);

export const renderDocumentSchema = z.object({
  tenantId: uuid,
  type: documentTypeEnum,
  recordId: uuid,
});
export type RenderDocumentInput = z.infer<typeof renderDocumentSchema>;

export const buildDatasetSchema = z.object({
  tenantId: uuid,
  type: documentTypeEnum,
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(5000).default(2000),
});
export type BuildDatasetInput = z.infer<typeof buildDatasetSchema>;

export const recordDocumentEventSchema = z.object({
  tenantId: uuid,
  type: documentTypeEnum,
  documentId: uuid.optional(),
  documentNumber: z.string().max(60).optional(),
  action: z.enum(["viewed", "printed", "downloaded", "exported", "emailed"]),
  format: documentFormatEnum.optional(),
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const listDocumentEventsSchema = z.object({
  tenantId: uuid,
  type: documentTypeEnum.optional(),
  documentId: uuid.optional(),
  limit: z.number().int().min(1).max(300).default(100),
});

export const searchDocumentsSchema = z.object({
  tenantId: uuid,
  query: z.string().max(80).default(""),
  group: z.enum(["procurement", "inventory", "products", "sales", "operations"]).optional(),
  limit: z.number().int().min(1).max(100).default(40),
});