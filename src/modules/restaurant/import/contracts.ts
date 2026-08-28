import { z } from "zod";
import { IMPORT_DOMAINS } from "./domains";

const uuid = z.string().uuid();
const tenantScope = z.object({ tenantId: uuid });

export const createImportWorkspaceSchema = tenantScope.extend({
  name: z.string().min(2).max(160),
  propertyId: uuid.optional(),
  locationId: uuid.optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateImportWorkspaceInput = z.infer<typeof createImportWorkspaceSchema>;

export const listImportWorkspacesSchema = tenantScope.extend({
  limit: z.number().int().min(1).max(100).default(30),
});

export const getImportWorkspaceSchema = tenantScope.extend({ workspaceId: uuid });

export const uploadImportSourceSchema = tenantScope.extend({
  workspaceId: uuid,
  kind: z.enum(["xlsx", "csv", "json", "pasted", "pdf", "image"]),
  originalFilename: z.string().max(255).optional(),
  mimeType: z.string().max(120).optional(),
  /** Base64 file body — required for xlsx/csv/pdf/image. */
  fileBase64: z
    .string()
    .max(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1024)
    .optional(),
  /** Inline text — required for pasted/json (and small csv pasted as text). */
  text: z.string().max(2_000_000).optional(),
});
export type UploadImportSourceInput = z.infer<typeof uploadImportSourceSchema>;

export const parseImportSourceSchema = tenantScope.extend({ sourceId: uuid });

export const fieldMappingEntrySchema = z.object({
  sourceColumn: z.string().max(160),
  canonicalField: z.string().max(80).nullable(),
  confidence: z.number().min(0).max(1),
  auto: z.boolean(),
});

export const confirmImportMappingSchema = tenantScope.extend({
  sourceId: uuid,
  sheetName: z.string().max(160),
  domain: z.enum(IMPORT_DOMAINS),
  mapping: z.array(fieldMappingEntrySchema).min(1),
});
export type ConfirmImportMappingInput = z.infer<typeof confirmImportMappingSchema>;

export const listStagedRecordsSchema = tenantScope.extend({
  workspaceId: uuid,
  domain: z.enum(IMPORT_DOMAINS).optional(),
  severity: z
    .enum(["cannot_map", "ambiguous_match", "missing_field", "new_entity", "auto_ok"])
    .optional(),
  decision: z.enum(["pending", "approved", "rejected", "skipped"]).optional(),
  limit: z.number().int().min(1).max(2000).default(500),
});

export const decideStagedRecordSchema = tenantScope.extend({
  recordId: uuid,
  decision: z.enum(["approved", "rejected", "skipped"]),
  /** A human correction to the matched entity, or an edit to a mapped field before approving. */
  matchedEntityId: uuid.nullish(),
  mappedDataPatch: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});
export type DecideStagedRecordInput = z.infer<typeof decideStagedRecordSchema>;

export const bulkDecideStagedRecordsSchema = tenantScope.extend({
  workspaceId: uuid,
  domain: z.enum(IMPORT_DOMAINS).optional(),
  severity: z
    .enum(["cannot_map", "ambiguous_match", "missing_field", "new_entity", "auto_ok"])
    .optional(),
  decision: z.enum(["approved", "rejected", "skipped"]),
});

export const commitImportWorkspaceSchema = tenantScope.extend({
  workspaceId: uuid,
  /** Used for any new menu items when the workspace itself has none picked — created as a draft menu if omitted. */
  targetMenuId: uuid.optional(),
});
export type CommitImportWorkspaceInput = z.infer<typeof commitImportWorkspaceSchema>;
