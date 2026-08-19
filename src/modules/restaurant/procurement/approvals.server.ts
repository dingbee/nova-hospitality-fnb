/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Configurable approval requirements.
 *
 * This is *not* a second permission system: it narrows the existing restaurant
 * role model per tenant, amount, outlet and category. The capability check in
 * `access.server.ts` still runs first.
 */
import type { RestaurantRole } from "../core/contracts";
import { isPlatformAdmin, rolesInTenant } from "../core/access.server";
import type { ApprovalRuleInput } from "./contracts";

type Sb = any;

export interface ResolvedApprovalRule {
  id: string | null;
  approverRoles: RestaurantRole[];
  requireSeparationOfDuties: boolean;
  source: "configured" | "default";
}

const DEFAULT_RULE: ResolvedApprovalRule = {
  id: null,
  approverRoles: ["owner", "general_manager", "restaurant_manager"],
  requireSeparationOfDuties: true,
  source: "default",
};

export async function listApprovalRules(sb: Sb, tenantId: string) {
  const { data, error } = await sb
    .from("restaurant_approval_rules")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("priority", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertApprovalRule(sb: Sb, input: ApprovalRuleInput) {
  const row = {
    id: input.id,
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    document_type: input.documentType,
    category: input.category ?? null,
    currency: input.currency,
    min_amount: input.minAmount,
    max_amount: input.maxAmount ?? null,
    approver_roles: input.approverRoles,
    require_separation_of_duties: input.requireSeparationOfDuties,
    priority: input.priority,
    active: input.active,
    notes: input.notes ?? null,
  };
  const { data, error } = await sb
    .from("restaurant_approval_rules")
    .upsert(row, { onConflict: "id" })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** First matching rule by priority; falls back to a safe default. */
export async function resolveApprovalRule(
  sb: Sb,
  scope: {
    tenantId: string;
    documentType: "purchase_request" | "purchase_order";
    amount: number;
    propertyId?: string | null;
    locationId?: string | null;
    category?: string | null;
  },
): Promise<ResolvedApprovalRule> {
  const { data } = await sb
    .from("restaurant_approval_rules")
    .select("*")
    .eq("tenant_id", scope.tenantId)
    .eq("document_type", scope.documentType)
    .eq("active", true)
    .order("priority", { ascending: true });

  const match = ((data ?? []) as any[]).find((r) => {
    if (r.property_id && scope.propertyId && r.property_id !== scope.propertyId) return false;
    if (r.location_id && scope.locationId && r.location_id !== scope.locationId) return false;
    if (r.category && scope.category && r.category !== scope.category) return false;
    if (Number(r.min_amount ?? 0) > scope.amount) return false;
    if (r.max_amount != null && Number(r.max_amount) < scope.amount) return false;
    return true;
  });

  if (!match) return DEFAULT_RULE;
  return {
    id: match.id,
    approverRoles: (match.approver_roles ?? DEFAULT_RULE.approverRoles) as RestaurantRole[],
    requireSeparationOfDuties: Boolean(match.require_separation_of_duties),
    source: "configured",
  };
}

/**
 * Separation of duties: the requester may not approve their own request unless
 * the tenant's rule explicitly allows it. Platform admins are not exempt when
 * they are also the requester — the audit trail must stay meaningful.
 */
export async function assertMayApprove(
  sb: Sb,
  userId: string,
  scope: {
    tenantId: string;
    documentType: "purchase_request" | "purchase_order";
    amount: number;
    requesterId?: string | null;
    propertyId?: string | null;
    locationId?: string | null;
    category?: string | null;
  },
): Promise<ResolvedApprovalRule> {
  const rule = await resolveApprovalRule(sb, scope);

  if (rule.requireSeparationOfDuties && scope.requesterId && scope.requesterId === userId) {
    throw new Error("Separation of duties — a requester cannot approve their own request.");
  }

  if (await isPlatformAdmin(sb, userId)) return rule;

  const roles = await rolesInTenant(sb, userId, scope.tenantId);
  const allowed = rule.approverRoles as readonly string[];
  if (!roles.some((r) => allowed.includes(r))) {
    throw new Error(`Approval requires one of: ${allowed.join(", ")}.`);
  }
  return rule;
}
