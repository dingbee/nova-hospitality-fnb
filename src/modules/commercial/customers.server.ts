/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P03 — Commercial Operations Centre: customer portfolio.
 *
 * `restaurant_tenants` remains the one customer identity (P02 §4/§29) —
 * this module only AGGREGATES existing P01/P02 records for an operational
 * view; it never introduces a parallel customer table. Every read here is
 * commercial-admin gated (§24: this is the "global portfolio" view, not a
 * tenant's own self-service read — a tenant's own commercial data stays
 * reachable through the existing P02 RLS-scoped reads used inside the
 * tenant-scoped Customer Workspace).
 *
 * Balance is computed once, here, and reused everywhere a customer's
 * outstanding balance is shown (list, profile) — §21's "one authoritative
 * server calculation" requirement.
 */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import type { AddCommercialNoteInput, ListCustomersInput } from "./contracts";

type Sb = any;

/** Outstanding balance = sum of `balance` on every invoice not void/cancelled. Single authoritative calculation (§21). */
export async function getCustomerBalance(sb: Sb, tenantId: string): Promise<number> {
  const { data, error } = await sb
    .from("commercial_invoices")
    .select("balance, status")
    .eq("tenant_id", tenantId)
    .not("status", "in", "(void,cancelled)");
  if (error) throw new Error(error.message);
  return (
    Math.round((data ?? []).reduce((s: number, i: any) => s + Number(i.balance), 0) * 100) / 100
  );
}

async function balancesByTenant(sb: Sb, tenantIds: string[]): Promise<Map<string, number>> {
  if (tenantIds.length === 0) return new Map();
  const { data, error } = await sb
    .from("commercial_invoices")
    .select("tenant_id, balance, status")
    .in("tenant_id", tenantIds)
    .not("status", "in", "(void,cancelled)");
  if (error) throw new Error(error.message);
  const map = new Map<string, number>();
  for (const row of (data ?? []) as any[]) {
    map.set(
      row.tenant_id,
      Math.round(((map.get(row.tenant_id) ?? 0) + Number(row.balance)) * 100) / 100,
    );
  }
  return map;
}

/**
 * §5/§23 — the Customers list: every tenant, enriched with billing status,
 * current subscription state, plan/programme and outstanding balance, with
 * server-side search so the whole portfolio is never pulled for a filter
 * a database can apply.
 */
export async function listCustomers(sb: Sb, userId: string, input: ListCustomersInput) {
  await assertCommercialAdmin(sb, userId);

  let tenantQuery = sb.from("restaurant_tenants").select("id, name, slug").order("name").limit(200);
  if (input.search) tenantQuery = tenantQuery.ilike("name", `%${input.search}%`);
  const { data: tenants, error: tenantErr } = await tenantQuery;
  if (tenantErr) throw new Error(tenantErr.message);
  const tenantRows: any[] = tenants ?? [];
  if (tenantRows.length === 0) return [];
  const tenantIds = tenantRows.map((t) => t.id);

  const [{ data: accounts }, { data: subs }, balances] = await Promise.all([
    sb
      .from("commercial_billing_accounts")
      .select("tenant_id, commercial_status, billing_contact_email")
      .in("tenant_id", tenantIds),
    sb
      .from("restaurant_subscriptions")
      .select(
        "tenant_id, status, renewal_date, agreement_id, commercial_plans(code, name), commercial_programmes(code, name)",
      )
      .in("tenant_id", tenantIds),
    balancesByTenant(sb, tenantIds),
  ]);

  const accountByTenant = new Map<string, any>((accounts ?? []).map((a: any) => [a.tenant_id, a]));
  const subByTenant = new Map<string, any>((subs ?? []).map((s: any) => [s.tenant_id, s]));

  let rows = tenantRows.map((t) => {
    const account = accountByTenant.get(t.id);
    const sub = subByTenant.get(t.id);
    return {
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      commercialStatus: account?.commercial_status ?? "prospect",
      billingContactEmail: account?.billing_contact_email ?? null,
      subscriptionStatus: sub?.status ?? null,
      planCode: sub?.commercial_plans?.code ?? null,
      programmeCode: sub?.commercial_programmes?.code ?? null,
      renewalDate: sub?.renewal_date ?? null,
      hasAgreement: Boolean(sub?.agreement_id),
      balance: balances.get(t.id) ?? 0,
    };
  });

  if (input.status) rows = rows.filter((r) => r.commercialStatus === input.status);
  return rows;
}

/**
 * §5/§6/§26 — the Customer Commercial Profile: everything an administrator
 * needs to answer "who is this customer, what did they sign, what do they
 * owe, when do they renew" in one read, assembled entirely from existing
 * authoritative P01/P02 records.
 */
export async function getCustomerCommercialProfile(sb: Sb, userId: string, tenantId: string) {
  await assertCommercialAdmin(sb, userId);

  const [
    { data: tenant, error: tenantErr },
    { data: billingAccount },
    { data: subscription },
    { data: agreements },
    { data: properties },
    { data: invoices },
    { data: payments },
    { data: activity },
  ] = await Promise.all([
    sb
      .from("restaurant_tenants")
      .select("id, name, slug, settings")
      .eq("id", tenantId)
      .maybeSingle(),
    sb.from("commercial_billing_accounts").select("*").eq("tenant_id", tenantId).maybeSingle(),
    sb
      .from("restaurant_subscriptions")
      .select("*, commercial_plans(code, name), commercial_programmes(code, name)")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    sb
      .from("commercial_agreements")
      .select("*, commercial_plans(code, name), commercial_programmes(code, name)")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
    sb
      .from("commercial_property_classifications")
      .select("*, restaurant_properties(name, slug)")
      .eq("tenant_id", tenantId)
      .order("property_sequence"),
    sb
      .from("commercial_invoices")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(50),
    sb
      .from("commercial_payments")
      .select("*, commercial_invoices(invoice_number)")
      .eq("tenant_id", tenantId)
      .order("received_at", { ascending: false })
      .limit(50),
    sb
      .from("commercial_audit_log")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (tenantErr) throw new Error(tenantErr.message);
  if (!tenant) throw new Error("Customer not found.");

  const balance =
    Math.round(
      (invoices ?? [])
        .filter((i: any) => !["void", "cancelled"].includes(i.status))
        .reduce((s: number, i: any) => s + Number(i.balance), 0) * 100,
    ) / 100;

  const currentAgreement =
    (agreements ?? []).find((a: any) => ["active", "approved"].includes(a.status)) ?? null;

  return {
    tenant,
    billingAccount: billingAccount ?? null,
    subscription: subscription ?? null,
    currentAgreement,
    agreements: agreements ?? [],
    properties: properties ?? [],
    invoices: invoices ?? [],
    payments: payments ?? [],
    activity: activity ?? [],
    balance,
  };
}

/**
 * §13/§19 — "record commercial note". Reuses the existing commercial audit
 * trail (§19 explicitly says not to build a second audit system) rather
 * than a new notes table — a note is simply an audited action with no
 * state mutation attached.
 */
export async function addCommercialNote(sb: Sb, userId: string, input: AddCommercialNoteInput) {
  await assertCommercialAdmin(sb, userId);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "note",
    entityType: "restaurant_tenants",
    entityId: input.tenantId,
    tenantId: input.tenantId,
    reason: input.note,
  });
  return { ok: true };
}
