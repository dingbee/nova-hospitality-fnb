/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Document audit trail. Append-only: every render, print, download and export
 * is recorded against the operational record, so "who took this out of the
 * system, when, and in what format" is always answerable.
 */
import type { DocumentAuditEntry } from "../core/types";

type Sb = any;

export interface DocumentEventInput {
  tenantId: string;
  documentType: string;
  documentId?: string | null;
  documentNumber?: string | null;
  action: string;
  format?: string | null;
  propertyId?: string | null;
  locationId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordDocumentEvent(sb: Sb, userId: string, e: DocumentEventInput): Promise<void> {
  const { error } = await sb.from("restaurant_document_events").insert({
    tenant_id: e.tenantId,
    property_id: e.propertyId ?? null,
    location_id: e.locationId ?? null,
    document_type: e.documentType,
    document_id: e.documentId ?? null,
    document_number: e.documentNumber ?? null,
    action: e.action,
    format: e.format ?? null,
    actor_id: userId,
    metadata: e.metadata ?? {},
  });
  // Losing an audit row must be visible in logs, but must never block the
  // user from getting the document they are entitled to.
  if (error) console.warn("[documents] audit not recorded", e.documentType, e.action, error.message);
}

export async function listDocumentEvents(
  sb: Sb,
  tenantId: string,
  filter: { documentType?: string; documentId?: string; limit?: number } = {},
) {
  let q = sb
    .from("restaurant_document_events")
    .select("id, document_type, document_id, document_number, action, format, actor_id, created_at, metadata")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 100);
  if (filter.documentType) q = q.eq("document_type", filter.documentType);
  if (filter.documentId) q = q.eq("document_id", filter.documentId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as any[];
}

/** Audit entries attached to a rendered document, newest first. */
export async function auditEntriesFor(
  sb: Sb,
  tenantId: string,
  documentType: string,
  documentId: string,
  limit = 12,
): Promise<DocumentAuditEntry[]> {
  const rows = await listDocumentEvents(sb, tenantId, { documentType, documentId, limit }).catch(() => []);
  return rows.map((r) => ({
    action: r.action,
    at: r.created_at,
    actorId: r.actor_id ?? null,
    format: r.format ?? null,
  }));
}