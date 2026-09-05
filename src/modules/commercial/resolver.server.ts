/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P01 — the central entitlement resolver.
 *
 * `resolveEntitlement(sb, tenantId, capabilityCode, context)` is the ONE
 * place commercial access decisions are made. UI, server actions, APIs,
 * background jobs and AI workloads all call this instead of hand-rolling
 * `if (plan === "pro")` checks — see `assertEntitled` below for the
 * enforcement half.
 *
 * Precedence (highest wins): an active commercial_overrides row for this
 * capability/tenant > the Founding-10-style programme's entitlement (if the
 * subscription carries an active programme AND that programme has
 * configured this capability) > the plan's baseline entitlement > a safe
 * "unavailable" default (an admin who never configured a plan entitlement
 * for a capability has not enabled it — never silently "included").
 * A capability marked `deprecated` in the registry is forced unavailable
 * regardless of any entitlement row, since it is no longer offered at all.
 */
import type { CapabilityStatus, EntitlementResult, EntitlementState, JsonValue } from "./contracts";
import { checkQuota, findQuotaCodeForCapability } from "./quota.server";
import { getEffectiveSubscription } from "./subscription.server";

type Sb = any;

export class CommercialEntitlementError extends Error {
  readonly status = 403;
  constructor(
    readonly capabilityCode: string,
    readonly state: EntitlementState,
  ) {
    super(`Forbidden — "${capabilityCode}" is not entitled on this plan (state: ${state}).`);
    this.name = "CommercialEntitlementError";
  }
}

export async function resolveEntitlement(
  sb: Sb,
  tenantId: string,
  capabilityCode: string,
  context: { propertyId?: string | null } = {},
): Promise<EntitlementResult> {
  const sub = await getEffectiveSubscription(sb, tenantId);

  const { data: capability } = await sb
    .from("commercial_capabilities")
    .select("id, status")
    .eq("code", capabilityCode)
    .maybeSingle();

  const empty = (
    state: EntitlementState,
    source: EntitlementResult["source"],
  ): EntitlementResult => ({
    capabilityCode,
    capabilityStatus: (capability?.status as CapabilityStatus) ?? "unknown",
    state,
    source,
    planCode: sub.planCode as EntitlementResult["planCode"],
    programmeCode: sub.programmeCode,
    config: {},
    quota: null,
  });

  if (!capability) return empty("unavailable", "default");
  if (capability.status === "deprecated") return empty("unavailable", "default");

  let state: EntitlementState = "unavailable";
  let config: Record<string, JsonValue> = {};
  let source: EntitlementResult["source"] = "default";

  const nowIso = new Date().toISOString();
  const { data: planRows } = await sb
    .from("commercial_plan_entitlements")
    .select("state, config, effective_from")
    .eq("plan_id", sub.planId)
    .eq("capability_id", capability.id)
    .lte("effective_from", nowIso)
    .or(`effective_until.is.null,effective_until.gt.${nowIso}`)
    .order("effective_from", { ascending: false })
    .limit(1);
  if (planRows?.[0]) {
    state = planRows[0].state;
    config = planRows[0].config ?? {};
    source = "plan";
  }

  if (sub.programmeId) {
    const { data: programmeRow } = await sb
      .from("commercial_programme_entitlements")
      .select("state, config")
      .eq("programme_id", sub.programmeId)
      .eq("capability_id", capability.id)
      .maybeSingle();
    if (programmeRow) {
      state = programmeRow.state;
      config = programmeRow.config ?? {};
      source = "programme";
    }
  }

  const { data: overrideRows } = await sb
    .from("commercial_overrides")
    .select("payload, tenant_id, scope_type")
    .eq("status", "active")
    .in("scope_type", ["capability", "tenant"])
    .lte("effective_from", nowIso)
    .or(`effective_until.is.null,effective_until.gt.${nowIso}`)
    .or(`scope_id.eq.${capability.id},scope_id.is.null`)
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
  const applicable = (overrideRows ?? []).find((r: any) => {
    if (r.scope_type === "capability") return true;
    return r.tenant_id === tenantId && r.payload?.capabilityCode === capabilityCode;
  });
  if (applicable?.payload?.state) {
    state = applicable.payload.state;
    config = { ...config, ...(applicable.payload.config ?? {}) };
    source = "override";
  }

  const quotaCode = await findQuotaCodeForCapability(sb, tenantId, capability.id);
  const quota = quotaCode ? await checkQuota(sb, tenantId, quotaCode, context.propertyId) : null;

  return {
    capabilityCode,
    capabilityStatus: capability.status,
    state,
    source,
    planCode: sub.planCode as EntitlementResult["planCode"],
    programmeCode: sub.programmeCode,
    config,
    quota,
  };
}

const ENTITLED_STATES: readonly EntitlementState[] = [
  "included",
  "limited",
  "advanced",
  "enterprise",
  "add_on",
];

/**
 * The enforcement half of the resolver: throws unless the capability is
 * entitled for this tenant. This is what server functions and route
 * loaders actually call — "a hidden button is not commercial enforcement."
 */
export async function assertEntitled(
  sb: Sb,
  tenantId: string,
  capabilityCode: string,
  context: { propertyId?: string | null } = {},
): Promise<EntitlementResult> {
  const result = await resolveEntitlement(sb, tenantId, capabilityCode, context);
  if (!ENTITLED_STATES.includes(result.state)) {
    throw new CommercialEntitlementError(capabilityCode, result.state);
  }
  return result;
}
