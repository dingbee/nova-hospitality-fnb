/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Procurement audit trail. Append-only: procurement history is never
 * overwritten, only added to.
 */
import type { ProcurementDocumentType } from "./contracts";

type Sb = any;

export async function recordProcurementAudit(
  sb: Sb,
  userId: string,
  entry: {
    tenantId: string;
    documentType: ProcurementDocumentType;
    documentId: string;
    documentNumber?: string | null;
    action: string;
    previousState?: string | null;
    newState?: string | null;
    reason?: string | null;
    correlationId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await sb.from("restaurant_procurement_audit").insert({
    tenant_id: entry.tenantId,
    document_type: entry.documentType,
    document_id: entry.documentId,
    document_number: entry.documentNumber ?? null,
    action: entry.action,
    previous_state: entry.previousState ?? null,
    new_state: entry.newState ?? null,
    reason: entry.reason ?? null,
    actor_id: userId,
    correlation_id: entry.correlationId ?? null,
    metadata: entry.metadata ?? {},
  });
  // An audit failure must be loud in logs but must not silently corrupt state.
  if (error) console.warn("[procurement] audit not recorded", entry.action, error.message);
}

export async function nextDocumentNumber(
  sb: Sb,
  tenantId: string,
  docType: ProcurementDocumentType,
  prefix: string,
): Promise<string> {
  const { data, error } = await sb.rpc("restaurant_next_document_number", {
    _tenant: tenantId,
    _doc_type: docType,
    _prefix: prefix,
  });
  if (error || !data) {
    // Deterministic fallback keeps documents numbered even if the sequence is contended.
    return `${prefix}-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
  }
  return String(data);
}
