/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P03 §14 — Renewal Management: read-side. `renewSubscription`
 * (subscription-lifecycle.server.ts) remains the ONE place a renewal is
 * executed; this module only surfaces which subscriptions are approaching
 * their `renewal_date` so an admin knows where to act.
 */
import { assertCommercialAdmin } from "./access.server";
import { getCustomerBalance } from "./customers.server";

type Sb = any;

export async function listUpcomingRenewals(sb: Sb, userId: string) {
  await assertCommercialAdmin(sb, userId);

  const { data: subs, error } = await sb
    .from("restaurant_subscriptions")
    .select(
      "*, restaurant_tenants(name, slug), commercial_plans(code, name), commercial_programmes(code, name)",
    )
    .in("status", ["active", "renewing", "past_due"])
    .not("renewal_date", "is", null)
    .order("renewal_date", { ascending: true });
  if (error) throw new Error(error.message);
  const rows: any[] = subs ?? [];
  if (rows.length === 0) return [];

  const tenantIds = rows.map((r) => r.tenant_id);
  const { data: classifications } = await sb
    .from("commercial_property_classifications")
    .select("tenant_id, chargeable")
    .in("tenant_id", tenantIds);
  const propertyCounts = new Map<string, { total: number; chargeable: number }>();
  for (const c of (classifications ?? []) as any[]) {
    const cur = propertyCounts.get(c.tenant_id) ?? { total: 0, chargeable: 0 };
    cur.total += 1;
    if (c.chargeable) cur.chargeable += 1;
    propertyCounts.set(c.tenant_id, cur);
  }

  const today = new Date();
  const balances = await Promise.all(rows.map((r) => getCustomerBalance(sb, r.tenant_id)));

  return rows.map((sub, i) => {
    const renewalDate = sub.renewal_date ? new Date(`${sub.renewal_date}T00:00:00Z`) : null;
    const daysUntilRenewal = renewalDate
      ? Math.ceil((renewalDate.getTime() - today.getTime()) / 86400000)
      : null;
    const counts = propertyCounts.get(sub.tenant_id) ?? { total: 0, chargeable: 0 };
    return {
      subscriptionId: sub.id,
      tenantId: sub.tenant_id,
      customerName: sub.restaurant_tenants?.name ?? sub.tenant_id,
      status: sub.status,
      planCode: sub.commercial_plans?.code ?? null,
      programmeCode: sub.commercial_programmes?.code ?? null,
      billingInterval: sub.billing_interval,
      renewalDate: sub.renewal_date,
      daysUntilRenewal,
      // Overdue balance or a past-due status is the clearest, data-backed
      // renewal-risk signal available without fabricating a risk score.
      atRisk: sub.status === "past_due" || balances[i] > 0,
      outstandingBalance: balances[i],
      propertyCount: counts.total,
      chargeablePropertyCount: counts.chargeable,
      agreementId: sub.agreement_id,
    };
  });
}
