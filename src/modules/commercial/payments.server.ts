/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P02 §16-18 — commercial payments.
 *
 * No payment-gateway credentials exist in this environment (confirmed by
 * inspection — see migration 0040's header note), so the one real, working
 * path is a commercial admin recording a payment they have already
 * received (bank transfer / mobile money reference) — never a client-side
 * "payment succeeded" callback (§16, §41: frontend payment state is never
 * authoritative). `verifyAndRecordWebhookPayment` below is the same
 * reconciliation core a real gateway webhook would call; it is unused by
 * any live endpoint today because no gateway is configured, but exists so
 * wiring one in later needs no schema or logic change, only a new caller.
 */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import { setCommercialStatus } from "./billing-account.server";
import type { RecordPaymentInput } from "./contracts";
import { sendCommercialNotification } from "./notifications.server";

type Sb = any;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function applyPaymentToInvoice(sb: Sb, invoiceId: string, amount: number) {
  const { data: invoice, error } = await sb
    .from("commercial_invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();
  if (error) throw new Error(error.message);
  const newPaid = round2(Number(invoice.amount_paid) + amount);
  const newBalance = round2(Number(invoice.total) - newPaid);
  const status = newBalance <= 0 ? "paid" : "partially_paid";
  const { data: updated, error: updateErr } = await sb
    .from("commercial_invoices")
    .update({ amount_paid: newPaid, balance: Math.max(newBalance, 0), status })
    .eq("id", invoiceId)
    .select("*")
    .single();
  if (updateErr) throw new Error(updateErr.message);
  return { before: invoice, after: updated };
}

/**
 * Idempotent per (tenant, idempotencyKey) — a retried recording request
 * (double-click, network retry) returns the already-recorded payment
 * instead of applying it twice (§37). Records the payment as
 * `status: "succeeded"` because a manual entry only ever happens after the
 * money has genuinely arrived — there is no "pending manual payment"
 * concept, unlike a gateway's asynchronous confirmation.
 */
export async function recordPayment(sb: Sb, userId: string, input: RecordPaymentInput) {
  await assertCommercialAdmin(sb, userId);

  const { data: invoice, error: invErr } = await sb
    .from("commercial_invoices")
    .select("id, tenant_id, status, total, balance, invoice_number")
    .eq("id", input.invoiceId)
    .single();
  if (invErr) throw new Error(invErr.message);
  if (!["issued", "partially_paid"].includes(invoice.status)) {
    throw new Error(`Cannot record a payment against an invoice in status "${invoice.status}".`);
  }

  const { data: existing } = await sb
    .from("commercial_payments")
    .select("*")
    .eq("tenant_id", invoice.tenant_id)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existing) return existing;

  // Never let a payment drive the invoice balance negative — a genuine
  // overpayment is a manual reconciliation matter (credit/refund), out of
  // this sprint's scope, not something to silently absorb into balance math.
  if (input.amount > Number(invoice.balance) + 0.01) {
    throw new Error(
      `Payment of ${input.currency} ${input.amount.toLocaleString()} exceeds the invoice's outstanding balance of ${input.currency} ${Number(invoice.balance).toLocaleString()}.`,
    );
  }

  const { data: billingAccount } = await sb
    .from("commercial_billing_accounts")
    .select("id")
    .eq("tenant_id", invoice.tenant_id)
    .maybeSingle();

  const { data: payment, error } = await sb
    .from("commercial_payments")
    .insert({
      tenant_id: invoice.tenant_id,
      invoice_id: invoice.id,
      billing_account_id: billingAccount?.id ?? null,
      method: input.method,
      provider: "manual",
      provider_reference: input.providerReference ?? null,
      amount: input.amount,
      currency: input.currency,
      status: "succeeded",
      idempotency_key: input.idempotencyKey,
      notes: input.notes ?? null,
      recorded_by: userId,
      received_at: input.receivedAt ?? new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error) {
    // Idempotency-key unique-constraint race — return the winner.
    const { data: winner } = await sb
      .from("commercial_payments")
      .select("*")
      .eq("tenant_id", invoice.tenant_id)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (winner) return winner;
    throw new Error(error.message);
  }

  const { before, after } = await applyPaymentToInvoice(sb, invoice.id, input.amount);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "payment.record",
    entityType: "commercial_payments",
    entityId: payment.id,
    tenantId: invoice.tenant_id,
    before,
    after: { payment, invoice: after },
    reference: invoice.invoice_number,
  });

  const { data: account } = await sb
    .from("commercial_billing_accounts")
    .select("commercial_status")
    .eq("tenant_id", invoice.tenant_id)
    .maybeSingle();
  if (!account || ["prospect", "past_due"].includes(account.commercial_status)) {
    await setCommercialStatus(sb, userId, invoice.tenant_id, "active");
  }

  await sendCommercialNotification(sb, {
    tenantId: invoice.tenant_id,
    eventType: "payment_received",
    entityType: "commercial_payments",
    entityId: payment.id,
    idempotencyKey: `payment-received-${payment.id}`,
    subject: `Payment received — ${invoice.invoice_number}`,
    body: `We've recorded a payment of ${input.currency} ${input.amount.toLocaleString()} against invoice ${invoice.invoice_number}. New balance: ${input.currency} ${Number(after.balance).toLocaleString()}.`,
  });

  return payment;
}

export async function listPayments(sb: Sb, filter: { tenantId?: string; invoiceId?: string }) {
  let q = sb
    .from("commercial_payments")
    .select("*, restaurant_tenants(name, slug), commercial_invoices(invoice_number)")
    .order("received_at", { ascending: false });
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  if (filter.invoiceId) q = q.eq("invoice_id", filter.invoiceId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * The reconciliation core a real gateway webhook handler would call:
 * idempotent on (provider, eventId), verifies the referenced invoice
 * belongs to the claimed tenant and the amount/currency match before
 * applying anything. Not wired to any live HTTP endpoint in this sprint —
 * no gateway is configured to call one — but the schema
 * (`commercial_payment_webhook_events`) and this function exist so adding
 * a real provider later is "write an endpoint that calls this", not "design
 * the reconciliation logic from scratch".
 */
export async function verifyAndRecordWebhookPayment(
  sb: Sb,
  input: {
    provider: string;
    eventId: string;
    invoiceId: string;
    tenantId: string;
    amount: number;
    currency: string;
    providerReference: string;
    payload: Record<string, unknown>;
  },
): Promise<{ status: "processed" | "duplicate" | "rejected"; reason?: string }> {
  const { data: existingEvent } = await sb
    .from("commercial_payment_webhook_events")
    .select("id, processed_at")
    .eq("provider", input.provider)
    .eq("event_id", input.eventId)
    .maybeSingle();
  if (existingEvent?.processed_at) return { status: "duplicate" };

  const { data: eventRow, error: eventErr } = await sb
    .from("commercial_payment_webhook_events")
    .upsert(
      { provider: input.provider, event_id: input.eventId, payload: input.payload },
      { onConflict: "provider,event_id" },
    )
    .select("id")
    .single();
  if (eventErr) throw new Error(eventErr.message);

  const { data: invoice } = await sb
    .from("commercial_invoices")
    .select("id, tenant_id, currency, balance, status, invoice_number")
    .eq("id", input.invoiceId)
    .maybeSingle();
  if (!invoice || invoice.tenant_id !== input.tenantId || invoice.currency !== input.currency) {
    await sb
      .from("commercial_payment_webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        processing_error: "invoice/tenant/currency mismatch",
      })
      .eq("id", eventRow.id);
    return { status: "rejected", reason: "invoice/tenant/currency mismatch" };
  }
  if (!["issued", "partially_paid"].includes(invoice.status)) {
    await sb
      .from("commercial_payment_webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        processing_error: `invoice status "${invoice.status}"`,
      })
      .eq("id", eventRow.id);
    return { status: "rejected", reason: `invoice status "${invoice.status}"` };
  }

  const { data: payment, error } = await sb
    .from("commercial_payments")
    .insert({
      tenant_id: invoice.tenant_id,
      invoice_id: invoice.id,
      method: "gateway",
      provider: input.provider,
      provider_reference: input.providerReference,
      amount: input.amount,
      currency: input.currency,
      status: "succeeded",
      idempotency_key: `webhook-${input.provider}-${input.eventId}`,
      raw_payload: input.payload,
      received_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  await applyPaymentToInvoice(sb, invoice.id, Math.min(input.amount, Number(invoice.balance)));
  await sb
    .from("commercial_payment_webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("id", eventRow.id);
  await writeCommercialAudit(sb, {
    actorId: "00000000-0000-0000-0000-000000000000",
    action: "payment.webhook",
    entityType: "commercial_payments",
    entityId: payment.id,
    tenantId: invoice.tenant_id,
    after: { provider: input.provider, eventId: input.eventId, amount: input.amount },
    reference: invoice.invoice_number,
  });
  return { status: "processed" };
}
