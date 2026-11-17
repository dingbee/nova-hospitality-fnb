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

/**
 * Inserts a document whose `reference` column is generated from
 * `nextDocumentNumber` and carries its own tenant-scoped uniqueness
 * constraint (e.g. restaurant_purchase_orders' `(tenant_id, reference)`).
 *
 * `nextDocumentNumber`'s sequence guarantees a fresh number is never
 * reused, but it commits independently of the row insert that follows it:
 * if that insert fails, the number is already gone. This helper retries
 * with a NEW number when the insert fails specifically on the named
 * reference-uniqueness constraint — covering the case where the sequence
 * and pre-existing references have drifted apart (e.g. legacy/imported
 * rows inserted outside the generator). A bounded number of attempts keeps
 * a genuinely broken sequence from looping forever.
 *
 * This never applies to a caller-supplied reference: a human or another
 * system explicitly chose that value (e.g. a supplier's own PO number),
 * so silently substituting a different one on collision would be wrong —
 * that case must be validated by the caller before this runs and, if it
 * still races past that check, surfaces as a real, un-retried error here.
 */
export async function insertWithUniqueDocumentNumber(
  sb: Sb,
  tenantId: string,
  docType: ProcurementDocumentType,
  prefix: string,
  referenceConstraintName: string,
  insertRow: (
    documentNumber: string,
  ) => Promise<{ data: any; error: { code?: unknown; message?: string } | null }>,
  options?: { retryOnCollision?: boolean; maxAttempts?: number },
): Promise<any> {
  const retryOnCollision = options?.retryOnCollision ?? true;
  const maxAttempts = options?.maxAttempts ?? 5;
  let lastError: { code?: unknown; message?: string } | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const documentNumber = await nextDocumentNumber(sb, tenantId, docType, prefix);
    const { data, error } = await insertRow(documentNumber);
    if (!error) return data;
    lastError = error;
    const isReferenceCollision =
      String(error.code) === "23505" &&
      String(error.message ?? "").includes(referenceConstraintName);
    if (!retryOnCollision || !isReferenceCollision || attempt === maxAttempts) break;
  }
  throw new Error(lastError?.message ?? "Failed to create document.");
}
