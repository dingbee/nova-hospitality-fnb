import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  bulkDecideStagedRecordsSchema,
  commitImportWorkspaceSchema,
  confirmImportMappingSchema,
  createImportWorkspaceSchema,
  decideStagedRecordSchema,
  getImportWorkspaceSchema,
  listImportWorkspacesSchema,
  listStagedRecordsSchema,
  parseImportSourceSchema,
  uploadImportSourceSchema,
} from "./contracts";
import { IMPORT_DOMAINS } from "./domains";

export const createImportWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createImportWorkspaceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.createImportWorkspace(context.supabase, context.userId, data);
  });

export const listImportWorkspacesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listImportWorkspacesSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.listImportWorkspaces(context.supabase, context.userId, data);
  });

export const getImportWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => getImportWorkspaceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.getImportWorkspace(context.supabase, context.userId, data);
  });

export const uploadImportSourceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => uploadImportSourceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.uploadImportSource(context.supabase, context.userId, data);
  });

export const parseImportSourceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => parseImportSourceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.parseImportSource(context.supabase, context.userId, data);
  });

const suggestImportMappingSchema = z.object({
  tenantId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sheetName: z.string().max(160),
  domain: z.enum(IMPORT_DOMAINS),
});

export const suggestImportMappingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => suggestImportMappingSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.suggestImportMapping(context.supabase, context.userId, data);
  });

export const confirmImportMappingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => confirmImportMappingSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.confirmImportMapping(context.supabase, context.userId, data);
  });

export const listStagedRecordsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listStagedRecordsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.listStagedRecords(context.supabase, context.userId, data);
  });

export const decideStagedRecordFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => decideStagedRecordSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.decideStagedRecord(context.supabase, context.userId, data);
  });

export const bulkDecideStagedRecordsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => bulkDecideStagedRecordsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.bulkDecideStagedRecords(context.supabase, context.userId, data);
  });

export const commitImportWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => commitImportWorkspaceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./import.server");
    return mod.commitImportWorkspace(context.supabase, context.userId, data);
  });
