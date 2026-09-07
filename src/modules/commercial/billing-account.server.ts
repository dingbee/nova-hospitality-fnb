/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P02 — Billing account: the 1:1 commercial-identity extension of a tenant
 * (billing contact, currency, tax id, commercial status). This is NOT a
 * second customer entity — `restaurant_tenants` remains the one customer
 * identity; this table only carries the commercial-billing facts a tenant
 * row has no columns for, the same way `commercial_property_classifications`
 * extends `restaurant_properties` rather than duplicating it.
 */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import type { UpsertBillingAccountInput } from "./contracts";

type Sb = any;

export async function getBillingAccount(sb: Sb, tenantId: string) {
  const { data, error } = await sb
    .from("commercial_billing_accounts")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function listBillingAccounts(sb: Sb) {
  const { data, error } = await sb
    .from("commercial_billing_accounts")
    .select("*, restaurant_tenants(name, slug)")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Idempotent create-or-update. A billing account starts implicitly as
 * "prospect" — commercial_status only ever advances through explicit
 * subscription-lifecycle actions (activateSubscription, suspend, cancel),
 * never through this form, so a commercial admin editing a contact detail
 * can never accidentally reactivate or suspend a customer.
 */
export async function upsertBillingAccount(
  sb: Sb,
  userId: string,
  input: UpsertBillingAccountInput,
) {
  await assertCommercialAdmin(sb, userId);
  const { data: existing } = await sb
    .from("commercial_billing_accounts")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .maybeSingle();

  const row = {
    tenant_id: input.tenantId,
    currency: input.currency,
    billing_contact_name: input.billingContactName ?? null,
    billing_contact_email: input.billingContactEmail ?? null,
    billing_contact_phone: input.billingContactPhone ?? null,
    billing_address: input.billingAddress ?? null,
    tax_id: input.taxId ?? null,
    payment_method_reference: input.paymentMethodReference ?? null,
    notes: input.notes ?? null,
  };
  const q = existing
    ? sb.from("commercial_billing_accounts").update(row).eq("tenant_id", input.tenantId)
    : sb.from("commercial_billing_accounts").insert(row);
  const { data, error } = await q.select("*").single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: existing ? "billing_account.update" : "billing_account.create",
    entityType: "commercial_billing_accounts",
    entityId: data.id,
    tenantId: input.tenantId,
    before: existing ?? null,
    after: data,
  });
  return data;
}

/**
 * Server-internal status transition — never exposed as a direct write
 * endpoint. Called only by subscription-lifecycle.server.ts so the
 * commercial_status on the billing account always mirrors a real
 * subscription-lifecycle decision, never a free-form edit.
 */
export async function setCommercialStatus(
  sb: Sb,
  userId: string,
  tenantId: string,
  status: "prospect" | "active" | "past_due" | "suspended" | "cancelled",
) {
  const { data: existing } = await sb
    .from("commercial_billing_accounts")
    .select("id")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!existing) {
    // A billing account is created lazily the first time its status needs
    // to move off the implicit "prospect" default — never required as a
    // manual setup step before a customer can be activated.
    const { data, error } = await sb
      .from("commercial_billing_accounts")
      .insert({ tenant_id: tenantId, commercial_status: status })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await writeCommercialAudit(sb, {
      actorId: userId,
      action: "billing_account.status",
      entityType: "commercial_billing_accounts",
      entityId: data.id,
      tenantId,
      after: { commercial_status: status },
    });
    return;
  }
  const { error } = await sb
    .from("commercial_billing_accounts")
    .update({ commercial_status: status })
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "billing_account.status",
    entityType: "commercial_billing_accounts",
    entityId: existing.id,
    tenantId,
    after: { commercial_status: status },
  });
}
