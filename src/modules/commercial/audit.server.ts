/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Commercial audit log writer. Every material commercial configuration
 * change (plan/price/entitlement/quota/threshold/overage-policy/
 * property-policy/programme/override/subscription/property-classification)
 * goes through this one function, mirroring the existing best-effort
 * pattern in reconciliation.server.ts's audit() — losing the trail must be
 * loud, but must never roll back a correct, already-authorized action.
 */
type Sb = any;

export interface CommercialAuditEntry {
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  tenantId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  reference?: string | null;
}

export async function writeCommercialAudit(sb: Sb, entry: CommercialAuditEntry): Promise<void> {
  const { error } = await sb.from("commercial_audit_log").insert({
    actor_id: entry.actorId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    tenant_id: entry.tenantId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    reference: entry.reference ?? null,
  });
  if (error) console.warn("[commercial] audit not recorded", entry.action, error.message);
}
