/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P01 — usage quota engine.
 *
 * Quota definitions, thresholds and overage policy are all read from
 * `commercial_quota_definitions` — nothing here is hardcoded. A quota
 * definition is matched to a subscription by specificity: a definition
 * naming both the tenant's plan and programme wins over one naming just the
 * plan, which wins over one naming neither (a capability- or code-only
 * default). Usage is counted per (tenant, property-or-tenant-wide,
 * quota definition, period) in `commercial_usage_counters`.
 *
 * Lifecycle states (NORMAL/WARNING/NEAR_LIMIT/LIMIT_REACHED/BLOCKED/
 * OVERRIDE) are derived from the admin-configured warning/near-limit
 * thresholds — never a hardcoded "80% = warning".
 */
import type { OverageBehavior, QuotaPeriod, QuotaStatus, QuotaUnit, UsageState } from "./contracts";
import { getEffectiveSubscription } from "./subscription.server";

type Sb = any;

export class QuotaExceededError extends Error {
  readonly status = 402;
  constructor(
    readonly quotaCode: string,
    readonly status_: QuotaStatus,
  ) {
    super(
      `Quota exceeded — "${quotaCode}" is at ${status_.usedValue}/${status_.limitValue} ${status_.unit} for this ${status_.period} and its overage policy is "block".`,
    );
    this.name = "QuotaExceededError";
  }
}

interface QuotaDefinitionRow {
  id: string;
  code: string;
  unit: QuotaUnit;
  limit_value: number;
  period: QuotaPeriod;
  scope: string;
  warning_threshold_pct: number;
  near_limit_threshold_pct: number;
  overage_behavior: OverageBehavior;
  plan_id: string | null;
  programme_id: string | null;
}

async function findQuotaDefinition(
  sb: Sb,
  tenantId: string,
  quotaCode: string,
): Promise<QuotaDefinitionRow | null> {
  const sub = await getEffectiveSubscription(sb, tenantId);
  const { data, error } = await sb
    .from("commercial_quota_definitions")
    .select(
      "id, code, unit, limit_value, period, scope, warning_threshold_pct, near_limit_threshold_pct, overage_behavior, plan_id, programme_id",
    )
    .eq("code", quotaCode)
    .eq("active", true)
    .lte("effective_from", new Date().toISOString())
    .or("effective_until.is.null,effective_until.gt." + new Date().toISOString());
  if (error) throw new Error(error.message);
  const rows: QuotaDefinitionRow[] = data ?? [];
  if (rows.length === 0) return null;

  const rank = (r: QuotaDefinitionRow): number => {
    if (r.plan_id === sub.planId && r.programme_id === sub.programmeId) return 0;
    if (r.plan_id === sub.planId && r.programme_id === null) return 1;
    if (r.plan_id === null && r.programme_id === sub.programmeId && sub.programmeId) return 2;
    if (r.plan_id === null && r.programme_id === null) return 3;
    return 99;
  };
  const candidates = rows.filter((r) => rank(r) < 99).sort((a, b) => rank(a) - rank(b));
  return candidates[0] ?? null;
}

/** Best-matching quota code linked to a capability (if any admin has configured one), for the entitlement resolver to attach usage-quota-state to a capability's entitlement result. */
export async function findQuotaCodeForCapability(
  sb: Sb,
  tenantId: string,
  capabilityId: string,
): Promise<string | null> {
  const sub = await getEffectiveSubscription(sb, tenantId);
  const { data, error } = await sb
    .from("commercial_quota_definitions")
    .select("code, plan_id, programme_id")
    .eq("capability_id", capabilityId)
    .eq("active", true)
    .lte("effective_from", new Date().toISOString())
    .or("effective_until.is.null,effective_until.gt." + new Date().toISOString());
  if (error) throw new Error(error.message);
  const rows: { code: string; plan_id: string | null; programme_id: string | null }[] = data ?? [];
  if (rows.length === 0) return null;
  const rank = (r: (typeof rows)[number]): number => {
    if (r.plan_id === sub.planId && r.programme_id === sub.programmeId) return 0;
    if (r.plan_id === sub.planId && r.programme_id === null) return 1;
    if (r.plan_id === null && r.programme_id === sub.programmeId && sub.programmeId) return 2;
    if (r.plan_id === null && r.programme_id === null) return 3;
    return 99;
  };
  const candidates = rows.filter((r) => rank(r) < 99).sort((a, b) => rank(a) - rank(b));
  return candidates[0]?.code ?? null;
}

/** Calendar-aligned period window. "billing_cycle" falls back to the calendar month — no billing engine exists yet to anchor it to. */
export function periodWindow(period: QuotaPeriod, now = new Date()): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (period) {
    case "day":
      return { start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1)) };
    case "week": {
      const dow = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
      const start = new Date(Date.UTC(y, m, d - (dow - 1)));
      return {
        start,
        end: new Date(
          Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7),
        ),
      };
    }
    case "year":
      return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
    case "month":
    case "billing_cycle":
    default:
      return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
  }
}

function deriveState(usedValue: number, def: QuotaDefinitionRow, hasOverride: boolean): UsageState {
  if (hasOverride) return "OVERRIDE";
  if (def.limit_value <= 0) return usedValue > 0 ? "LIMIT_REACHED" : "NORMAL";
  const pct = (usedValue / def.limit_value) * 100;
  if (pct >= 100) return def.overage_behavior === "block" ? "BLOCKED" : "LIMIT_REACHED";
  if (pct >= def.near_limit_threshold_pct) return "NEAR_LIMIT";
  if (pct >= def.warning_threshold_pct) return "WARNING";
  return "NORMAL";
}

async function findActiveQuotaOverride(sb: Sb, tenantId: string, quotaDefinitionId: string) {
  const nowIso = new Date().toISOString();
  const { data } = await sb
    .from("commercial_overrides")
    .select("id, payload, tenant_id")
    .eq("scope_type", "quota")
    .eq("scope_id", quotaDefinitionId)
    .eq("status", "active")
    .lte("effective_from", nowIso)
    .or(`effective_until.is.null,effective_until.gt.${nowIso}`)
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`);
  return (data ?? [])[0] ?? null;
}

/** Read-only peek: current usage/state, without incrementing anything. */
export async function checkQuota(
  sb: Sb,
  tenantId: string,
  quotaCode: string,
  propertyId?: string | null,
): Promise<QuotaStatus | null> {
  const def = await findQuotaDefinition(sb, tenantId, quotaCode);
  if (!def) return null;
  const override = await findActiveQuotaOverride(sb, tenantId, def.id);
  const effectiveLimit =
    override && typeof (override.payload as any)?.limitValue === "number"
      ? (override.payload as any).limitValue
      : def.limit_value;
  const { start, end } = periodWindow(def.period);
  const scopedProperty = def.scope === "property" ? (propertyId ?? null) : null;
  let q = sb
    .from("commercial_usage_counters")
    .select("used_value, state")
    .eq("tenant_id", tenantId)
    .eq("quota_definition_id", def.id)
    .eq("period_start", start.toISOString());
  q = scopedProperty ? q.eq("property_id", scopedProperty) : q.is("property_id", null);
  const { data: counter } = await q.maybeSingle();
  const usedValue = counter?.used_value ?? 0;
  const hasOverride = Boolean(override?.payload && (override.payload as any).bypass === true);
  return {
    quotaCode: def.code,
    unit: def.unit,
    limitValue: effectiveLimit,
    usedValue,
    period: def.period,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    state: deriveState(usedValue, { ...def, limit_value: effectiveLimit }, hasOverride),
    overageBehavior: def.overage_behavior,
    warningThresholdPct: def.warning_threshold_pct,
    nearLimitThresholdPct: def.near_limit_threshold_pct,
    hasOverride,
  };
}

/**
 * Checks the quota and, unless already BLOCKED, increments usage by
 * `amount` and returns the post-increment status. Fails closed: a quota at
 * its hard limit with overage_behavior "block" throws QuotaExceededError
 * instead of silently permitting the call — "the system must not silently
 * permit uncontrolled usage that creates commercial or AI cost exposure."
 * A quota with no definition at all (not configured) is treated as
 * unmetered and always allowed — an admin who has not configured a limit
 * has not asked for one to be enforced.
 */
export async function incrementUsage(
  sb: Sb,
  tenantId: string,
  quotaCode: string,
  opts: { propertyId?: string | null; amount?: number } = {},
): Promise<QuotaStatus | null> {
  const amount = opts.amount ?? 1;
  const before = await checkQuota(sb, tenantId, quotaCode, opts.propertyId);
  if (!before) return null;
  if (before.state === "BLOCKED") throw new QuotaExceededError(quotaCode, before);

  const def = await findQuotaDefinition(sb, tenantId, quotaCode);
  if (!def) return null;
  const { start, end } = periodWindow(def.period);
  const scopedProperty = def.scope === "property" ? (opts.propertyId ?? null) : null;

  const newUsed = before.usedValue + amount;
  const newState = deriveState(
    newUsed,
    { ...def, limit_value: before.limitValue },
    before.hasOverride,
  );

  let existingQ = sb
    .from("commercial_usage_counters")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("quota_definition_id", def.id)
    .eq("period_start", start.toISOString());
  existingQ = scopedProperty
    ? existingQ.eq("property_id", scopedProperty)
    : existingQ.is("property_id", null);
  const { data: existing } = await existingQ.maybeSingle();

  if (existing) {
    const { error } = await sb
      .from("commercial_usage_counters")
      .update({ used_value: newUsed, state: newState, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb.from("commercial_usage_counters").insert({
      tenant_id: tenantId,
      property_id: scopedProperty,
      quota_definition_id: def.id,
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      used_value: newUsed,
      state: newState,
    });
    // A concurrent first-increment can race the unique index; treat as a benign retry-losing case rather than failing the caller's whole request.
    if (error && !String(error.message).includes("commercial_usage_counters_unique")) {
      throw new Error(error.message);
    }
  }

  return { ...before, usedValue: newUsed, state: newState };
}
