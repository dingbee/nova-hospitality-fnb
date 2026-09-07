/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Effective subscription resolution.
 *
 * `restaurant_subscriptions` (the existing table, extended by migration
 * 0034 with plan_id/programme_id/billing_interval) had zero rows in
 * production at the time of this sprint — no prior write path ever
 * populated it. Rather than backfilling rows via migration (writing data
 * on the caller's behalf is exactly the kind of unrequested action P01's
 * "no unrelated feature work" rule warns against) a tenant with no
 * subscription row simply defaults to the CORE plan, active, no programme —
 * itself read from `commercial_plans`, never hardcoded. An admin can assign
 * a real plan via the Subscriptions panel at any time; every other part of
 * the commercial engine treats "no explicit subscription" and "an explicit
 * CORE subscription" identically.
 */
type Sb = any;

export interface EffectiveSubscription {
  subscriptionId: string | null;
  tenantId: string;
  planId: string;
  planCode: string;
  programmeId: string | null;
  programmeCode: string | null;
  status: string;
  billingInterval: string;
}

export async function getEffectiveSubscription(
  sb: Sb,
  tenantId: string,
): Promise<EffectiveSubscription> {
  const { data: sub } = await sb
    .from("restaurant_subscriptions")
    .select(
      "id, status, billing_interval, plan_id, programme_id, commercial_plans(id, code), commercial_programmes(id, code, status)",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (sub?.plan_id && sub.commercial_plans) {
    const programmeActive = sub.commercial_programmes?.status === "active";
    return {
      subscriptionId: sub.id,
      tenantId,
      planId: sub.plan_id,
      planCode: sub.commercial_plans.code,
      programmeId: programmeActive ? sub.programme_id : null,
      programmeCode: programmeActive ? (sub.commercial_programmes?.code ?? null) : null,
      status: sub.status,
      billingInterval: sub.billing_interval,
    };
  }

  const { data: corePlan, error } = await sb
    .from("commercial_plans")
    .select("id, code")
    .eq("code", "core")
    .single();
  if (error || !corePlan) {
    throw new Error("Commercial catalogue is not seeded — no CORE plan found.");
  }
  return {
    subscriptionId: sub?.id ?? null,
    tenantId,
    planId: corePlan.id,
    planCode: corePlan.code,
    programmeId: null,
    programmeCode: null,
    status: sub?.status ?? "active",
    billingInterval: sub?.billing_interval ?? "monthly",
  };
}
