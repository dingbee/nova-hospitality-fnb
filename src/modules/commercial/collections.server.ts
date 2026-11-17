/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P03 §12/§13/§22 — Collections / overdue operations.
 *
 * Reads only — every action available from this view (record payment,
 * suspend, renew) is an existing P02/P03 server function, never a
 * bespoke mutation. Ageing is computed at read time from `due_date`
 * (§12: no scheduler exists in this codebase, so overdue/ageing is never
 * a stored, automatically-transitioned state).
 */
import { assertCommercialAdmin } from "./access.server";
import { ageingFor } from "./billing-period";

type Sb = any;

export async function listCollections(sb: Sb, userId: string) {
  await assertCommercialAdmin(sb, userId);

  const { data: invoices, error } = await sb
    .from("commercial_invoices")
    .select("*, restaurant_tenants(name, slug)")
    .in("status", ["issued", "partially_paid"])
    .order("due_date", { ascending: true });
  if (error) throw new Error(error.message);
  const rows: any[] = invoices ?? [];
  if (rows.length === 0) return [];

  const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
  const { data: subs } = await sb
    .from("restaurant_subscriptions")
    .select("tenant_id, renewal_date, status")
    .in("tenant_id", tenantIds);
  const subByTenant = new Map<string, any>((subs ?? []).map((s: any) => [s.tenant_id, s]));

  const today = new Date();
  return rows
    .map((inv) => {
      const { bucket, daysOverdue } = ageingFor(inv.due_date, today);
      const sub = subByTenant.get(inv.tenant_id);
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        tenantId: inv.tenant_id,
        customerName: inv.restaurant_tenants?.name ?? inv.tenant_id,
        status: inv.status,
        total: Number(inv.total),
        amountPaid: Number(inv.amount_paid),
        balance: Number(inv.balance),
        dueDate: inv.due_date,
        ageingBucket: bucket,
        daysOverdue,
        subscriptionStatus: sub?.status ?? null,
        renewalDate: sub?.renewal_date ?? null,
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}
