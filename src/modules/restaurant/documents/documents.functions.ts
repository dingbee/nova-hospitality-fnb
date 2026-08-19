/**
 * Document layer RPC surface (Sprint 5.9).
 * Thin wrappers only — validation here, tenant/capability guards in the server.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildDatasetSchema,
  listDocumentEventsSchema,
  recordDocumentEventSchema,
  renderDocumentSchema,
  searchDocumentsSchema,
} from "./core/contracts";

export const renderRestaurantDocumentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => renderDocumentSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./builders/documents.server");
    const doc = await mod.renderDocument(context.supabase, context.userId, data.tenantId, data.type, data.recordId);
    const audit = await import("./audit/audit.server");
    await audit.recordDocumentEvent(context.supabase, context.userId, {
      tenantId: data.tenantId,
      documentType: data.type,
      documentId: data.recordId,
      documentNumber: doc.number,
      action: "viewed",
    });
    return doc;
  });

export const buildRestaurantDatasetFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => buildDatasetSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./exports/datasets.server");
    return mod.buildDataset(context.supabase, context.userId, data);
  });

export const buildRestaurantDailyClosingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    buildDatasetSchema.pick({ tenantId: true, propertyId: true, to: true }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const mod = await import("./builders/documents.server");
    return mod.buildDailyClosing(
      context.supabase,
      context.userId,
      data.tenantId,
      data.to ?? new Date().toISOString().slice(0, 10),
      data.propertyId ?? null,
    );
  });

export const recordRestaurantDocumentEventFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => recordDocumentEventSchema.parse(d))
  .handler(async ({ data, context }) => {
    // An audit row is a claim about a tenant. Only a member of that tenant may
    // make one, and the actor is always the authenticated caller.
    const guard = await import("../core/access.server");
    await guard.assertTenantRead(context.supabase, context.userId, data.tenantId);
    const mod = await import("./audit/audit.server");
    await mod.recordDocumentEvent(context.supabase, context.userId, {
      tenantId: data.tenantId,
      documentType: data.type,
      documentId: data.documentId ?? null,
      documentNumber: data.documentNumber ?? null,
      action: data.action,
      format: data.format ?? null,
      propertyId: data.propertyId ?? null,
      locationId: data.locationId ?? null,
      metadata: data.metadata,
    });
    return { ok: true };
  });

export const listRestaurantDocumentEventsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listDocumentEventsSchema.parse(d))
  .handler(async ({ data, context }) => {
    // Reading another tenant's audit trail is a cross-tenant read. Refuse it
    // here as well as in RLS.
    const guard = await import("../core/access.server");
    await guard.assertCapability(context.supabase, context.userId, data.tenantId, "documents.audit.read");
    const mod = await import("./audit/audit.server");
    return mod.listDocumentEvents(context.supabase, data.tenantId, {
      documentType: data.type,
      documentId: data.documentId,
      limit: data.limit,
    });
  });

export const searchRestaurantDocumentsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => searchDocumentsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const mod = await import("./search.server");
    return mod.searchDocuments(context.supabase, context.userId, data);
  });