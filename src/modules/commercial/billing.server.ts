/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P02 — the commercial billing/invoicing engine.
 *
 * ONE place invoice lines are computed, so nothing else in the codebase
 * hand-rolls a subscription charge, a property charge or a tax figure.
 * Every amount traces back to `commercial_agreements` (the signed-terms
 * snapshot — never the live pricing catalogue) or to
 * `commercial_property_classifications` (P01's already-decided,
 * already-priced property charge, never re-derived here).
 */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import { ageingFor, currentBillingPeriod, prorateForRemainderOfPeriod } from "./billing-period";
import type { GenerateInvoiceInput, IssueInvoiceInput, VoidInvoiceInput } from "./contracts";
import { sendCommercialNotification } from "./notifications.server";

type Sb = any;

interface DraftLine {
  kind: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  source_type: string | null;
  source_id: string | null;
  sort_order: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function nextInvoiceNumber(sb: Sb, tenantId: string): Promise<string> {
  const { data, error } = await sb.rpc("restaurant_next_document_number", {
    _tenant: tenantId,
    _doc_type: "commercial_invoice",
    _prefix: "INV",
  });
  if (error || !data) return `INV-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
  return String(data);
}

async function loadActiveAgreement(sb: Sb, tenantId: string) {
  const { data, error } = await sb
    .from("commercial_agreements")
    .select("*")
    .eq("tenant_id", tenantId)
    .in("status", ["active", "approved"])
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/** Every unbilled chargeable property classification for this tenant — never re-priced here, only read (P01 already decided the price). */
async function loadUnbilledPropertyCharges(sb: Sb, tenantId: string) {
  const { data: classifications, error } = await sb
    .from("commercial_property_classifications")
    .select("id, price_applied, currency, decided_at, restaurant_properties(name)")
    .eq("tenant_id", tenantId)
    .eq("chargeable", true);
  if (error) throw new Error(error.message);
  const rows: any[] = classifications ?? [];
  if (rows.length === 0) return [];
  const { data: billed } = await sb
    .from("commercial_invoice_lines")
    .select("source_id")
    .eq("source_type", "property_classification")
    .in(
      "source_id",
      rows.map((r) => r.id),
    );
  const billedIds = new Set((billed ?? []).map((r: any) => r.source_id));
  return rows.filter((r) => !billedIds.has(r.id));
}

/**
 * Builds the invoice line set for one billing period, from the agreement's
 * frozen terms plus any not-yet-billed chargeable properties. Never
 * touches the live pricing catalogue.
 */
async function buildInvoiceLines(
  sb: Sb,
  agreement: any,
  periodStart: string,
  periodEnd: string,
  includeImplementationFee: boolean,
): Promise<DraftLine[]> {
  const lines: DraftLine[] = [];
  let sort = 0;

  const basePrice =
    agreement.billing_interval === "annual" ? agreement.annual_price : agreement.monthly_price;
  // Never fabricate a base charge: an agreement whose plan has no fixed
  // price for this interval (e.g. Enterprise, negotiated separately)
  // produces no base line — an admin must set one explicitly.
  if (basePrice != null) {
    lines.push({
      kind: "base_subscription",
      description: `Subscription — ${agreement.billing_interval === "annual" ? "annual" : "monthly"} (${periodStart} to ${periodEnd})`,
      quantity: 1,
      unit_price: basePrice,
      amount: basePrice,
      source_type: "agreement",
      source_id: agreement.id,
      sort_order: sort++,
    });
  }

  if (includeImplementationFee && agreement.implementation_fee != null) {
    const { data: already } = await sb
      .from("commercial_invoice_lines")
      .select("id")
      .eq("source_type", "agreement")
      .eq("kind", "implementation")
      .eq("source_id", agreement.id)
      .limit(1)
      .maybeSingle();
    if (!already) {
      lines.push({
        kind: "implementation",
        description: "Implementation fee",
        quantity: 1,
        unit_price: agreement.implementation_fee,
        amount: agreement.implementation_fee,
        source_type: "agreement",
        source_id: agreement.id,
        sort_order: sort++,
      });
    }
  }

  const properties = await loadUnbilledPropertyCharges(sb, agreement.tenant_id);
  if (properties.length) {
    const { data: policyRows } = await sb
      .from("commercial_property_policies")
      .select("proration_policy")
      .eq("plan_id", agreement.plan_id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    const prorationPolicy = policyRows?.proration_policy ?? "next_period";
    const period = currentBillingPeriod(
      new Date(agreement.effective_from),
      agreement.billing_interval,
      new Date(periodEnd),
    );
    for (const p of properties) {
      if (p.price_applied == null) continue; // never fabricate a price P01 didn't set
      const decidedAt = new Date(p.decided_at);
      // "next_period": a property classified after the current period
      // opened is deferred to the FOLLOWING invoice run automatically —
      // it simply stays in loadUnbilledPropertyCharges until then, so no
      // special-casing is needed beyond skipping it here.
      if (prorationPolicy === "next_period" && decidedAt.getTime() > period.start.getTime()) {
        continue;
      }
      const amount =
        prorationPolicy === "prorated"
          ? prorateForRemainderOfPeriod(p.price_applied, period, decidedAt)
          : round2(p.price_applied);
      if (amount <= 0) continue;
      lines.push({
        kind: "additional_property",
        description: `Additional property — ${p.restaurant_properties?.name ?? "Property"}`,
        quantity: 1,
        unit_price: p.price_applied,
        amount,
        source_type: "property_classification",
        source_id: p.id,
        sort_order: sort++,
      });
    }
  }

  const subtotalBeforeDiscount = lines.reduce((s, l) => s + l.amount, 0);
  if (agreement.discount_pct != null && agreement.discount_pct > 0) {
    const discount = round2((subtotalBeforeDiscount * agreement.discount_pct) / 100);
    if (discount > 0) {
      lines.push({
        kind: "discount",
        description: agreement.discount_reason
          ? `Discount (${agreement.discount_pct}%) — ${agreement.discount_reason}`
          : `Discount (${agreement.discount_pct}%)`,
        quantity: 1,
        unit_price: -discount,
        amount: -discount,
        source_type: "agreement",
        source_id: agreement.id,
        sort_order: sort++,
      });
    }
  } else if (agreement.discount_amount != null && agreement.discount_amount > 0) {
    lines.push({
      kind: "discount",
      description: agreement.discount_reason
        ? `Discount — ${agreement.discount_reason}`
        : "Discount",
      quantity: 1,
      unit_price: -agreement.discount_amount,
      amount: -agreement.discount_amount,
      source_type: "agreement",
      source_id: agreement.id,
      sort_order: sort++,
    });
  }

  if (
    agreement.tax_treatment === "exclusive" &&
    agreement.tax_rate_pct != null &&
    agreement.tax_rate_pct > 0
  ) {
    const netSubtotal = lines.reduce((s, l) => s + l.amount, 0);
    const tax = round2((netSubtotal * agreement.tax_rate_pct) / 100);
    if (tax > 0) {
      lines.push({
        kind: "tax",
        description: `Tax (${agreement.tax_rate_pct}%)`,
        quantity: 1,
        unit_price: tax,
        amount: tax,
        source_type: "agreement",
        source_id: agreement.id,
        sort_order: sort++,
      });
    }
  }
  // "inclusive": prices already contain tax — total does not change; the
  // tax figure is informational only and is not modelled as a separate
  // invoice line here to avoid double counting against the base price.
  // "exempt": no tax line, ever.

  return lines;
}

function summarize(lines: DraftLine[]) {
  const discountTotal = round2(
    -lines.filter((l) => l.kind === "discount").reduce((s, l) => s + l.amount, 0),
  );
  const taxTotal = round2(lines.filter((l) => l.kind === "tax").reduce((s, l) => s + l.amount, 0));
  const subtotal = round2(
    lines
      .filter((l) => l.kind !== "discount" && l.kind !== "tax")
      .reduce((s, l) => s + l.amount, 0),
  );
  const total = round2(subtotal - discountTotal + taxTotal);
  return { subtotal, discountTotal, taxTotal, total };
}

async function insertInvoice(
  sb: Sb,
  userId: string,
  args: {
    tenantId: string;
    agreementId: string | null;
    subscriptionId: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    lines: DraftLine[];
  },
) {
  const { subtotal, discountTotal, taxTotal, total } = summarize(args.lines);
  const { data: invoice, error } = await sb
    .from("commercial_invoices")
    .insert({
      tenant_id: args.tenantId,
      invoice_number: await nextInvoiceNumber(sb, args.tenantId),
      agreement_id: args.agreementId,
      subscription_id: args.subscriptionId,
      billing_period_start: args.periodStart,
      billing_period_end: args.periodEnd,
      currency: "TZS",
      subtotal,
      discount_total: discountTotal,
      tax_total: taxTotal,
      total,
      amount_paid: 0,
      balance: total,
      status: "draft",
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  if (args.lines.length) {
    const { error: lineErr } = await sb
      .from("commercial_invoice_lines")
      .insert(args.lines.map((l) => ({ invoice_id: invoice.id, ...l })));
    if (lineErr) throw new Error(lineErr.message);
  }

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "invoice.create",
    entityType: "commercial_invoices",
    entityId: invoice.id,
    tenantId: args.tenantId,
    after: invoice,
    reference: invoice.invoice_number,
  });
  return invoice;
}

/**
 * Generates a draft invoice for one billing period against the tenant's
 * currently active agreement — the regular billing-cycle path (§10, §19).
 */
export async function generateInvoice(sb: Sb, userId: string, input: GenerateInvoiceInput) {
  await assertCommercialAdmin(sb, userId);
  const agreement = await loadActiveAgreement(sb, input.tenantId);
  if (!agreement) throw new Error("No approved or active commercial agreement for this tenant.");

  const lines = await buildInvoiceLines(
    sb,
    agreement,
    input.billingPeriodStart,
    input.billingPeriodEnd,
    input.includeImplementationFee,
  );
  if (lines.length === 0) {
    throw new Error(
      "Nothing to invoice for this period — the agreement has no configured price and there are no unbilled property charges.",
    );
  }
  return insertInvoice(sb, userId, {
    tenantId: input.tenantId,
    agreementId: agreement.id,
    subscriptionId: agreement.subscription_id,
    periodStart: input.billingPeriodStart,
    periodEnd: input.billingPeriodEnd,
    lines,
  });
}

/**
 * §12 — Property Commercial Classification → Invoice Line. Called by
 * property-classification.server.ts immediately after a property is
 * classified chargeable, so the charge is visible to the customer right
 * away as a draft (never silently activated, never silently deferred to an
 * invisible future invoice) — a commercial admin still has to explicitly
 * ISSUE it. Idempotent via the DB's partial unique index on
 * (source_type='property_classification', source_id): a retried call is a
 * no-op.
 */
export async function recordPropertyCharge(
  sb: Sb,
  userId: string,
  tenantId: string,
  classificationId: string,
) {
  const { data: classification, error } = await sb
    .from("commercial_property_classifications")
    .select("id, price_applied, currency, restaurant_properties(name)")
    .eq("id", classificationId)
    .single();
  if (error) throw new Error(error.message);
  if (classification.price_applied == null) return null; // nothing to charge

  const { data: alreadyBilled } = await sb
    .from("commercial_invoice_lines")
    .select("id")
    .eq("source_type", "property_classification")
    .eq("source_id", classificationId)
    .maybeSingle();
  if (alreadyBilled) return null;

  const line: DraftLine = {
    kind: "additional_property",
    description: `Additional property — ${classification.restaurant_properties?.name ?? "Property"}`,
    quantity: 1,
    unit_price: classification.price_applied,
    amount: classification.price_applied,
    source_type: "property_classification",
    source_id: classification.id,
    sort_order: 0,
  };
  try {
    return await insertInvoice(sb, userId, {
      tenantId,
      agreementId: null,
      subscriptionId: null,
      periodStart: null,
      periodEnd: null,
      lines: [line],
    });
  } catch (e) {
    // A unique-index race (two concurrent classifications of the same
    // property, which cannot happen by construction, or a retried
    // request) must not surface as a hard failure to the property-creation
    // flow that triggered this — the classification itself already
    // succeeded and is the authoritative record either way.
    console.warn("[commercial] property charge invoice not created", (e as Error).message);
    return null;
  }
}

export async function issueInvoice(sb: Sb, userId: string, input: IssueInvoiceInput) {
  await assertCommercialAdmin(sb, userId);
  const { data: existing, error: readErr } = await sb
    .from("commercial_invoices")
    .select("*")
    .eq("id", input.invoiceId)
    .single();
  if (readErr) throw new Error(readErr.message);
  if (existing.status !== "draft") {
    throw new Error(`Cannot issue an invoice in status "${existing.status}".`);
  }
  const issueDate = new Date().toISOString().slice(0, 10);
  const dueDate =
    input.dueDate ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data, error } = await sb
    .from("commercial_invoices")
    .update({ status: "issued", issue_date: issueDate, due_date: dueDate, issued_by: userId })
    .eq("id", input.invoiceId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "invoice.issue",
    entityType: "commercial_invoices",
    entityId: data.id,
    tenantId: data.tenant_id,
    before: existing,
    after: data,
    reference: data.invoice_number,
  });
  const { renderCommercialDocumentHtml } = await import("./documents.server");
  const html = await renderCommercialDocumentHtml(sb, "invoice", data.id).catch(() => undefined);
  await sendCommercialNotification(sb, {
    tenantId: data.tenant_id,
    eventType: "invoice_issued",
    entityType: "commercial_invoices",
    entityId: data.id,
    idempotencyKey: `invoice-issued-${data.id}`,
    subject: `Invoice ${data.invoice_number} issued`,
    body: `Invoice ${data.invoice_number} for ${data.currency} ${Number(data.total).toLocaleString()} is now due ${dueDate}.`,
    html,
  });
  return data;
}

export async function voidInvoice(sb: Sb, userId: string, input: VoidInvoiceInput) {
  await assertCommercialAdmin(sb, userId);
  const { data: existing, error: readErr } = await sb
    .from("commercial_invoices")
    .select("*")
    .eq("id", input.invoiceId)
    .single();
  if (readErr) throw new Error(readErr.message);
  if (existing.status === "paid") {
    throw new Error("Cannot void a fully paid invoice — issue a credit/refund instead.");
  }
  if (existing.status === "void" || existing.status === "cancelled") return existing;

  const { data, error } = await sb
    .from("commercial_invoices")
    .update({ status: "void", void_reason: input.reason, voided_at: new Date().toISOString() })
    .eq("id", input.invoiceId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "invoice.void",
    entityType: "commercial_invoices",
    entityId: data.id,
    tenantId: data.tenant_id,
    before: existing,
    after: data,
    reason: input.reason,
  });
  return data;
}

export async function listInvoices(sb: Sb, filter: { tenantId?: string; status?: string }) {
  let q = sb
    .from("commercial_invoices")
    .select("*, restaurant_tenants(name, slug)")
    .order("created_at", { ascending: false });
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  if (filter.status) q = q.eq("status", filter.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  return ((data ?? []) as any[]).map((inv) => {
    // §22 — one ageing implementation (ageingFor), reused wherever an
    // invoice's age is shown; never a second computation here.
    const { bucket, daysOverdue } = ageingFor(inv.due_date, today);
    return {
      ...inv,
      // Computed, not stored — see the module header note on why there is
      // no scheduler to transition this automatically.
      overdue:
        inv.status === "issued" &&
        inv.due_date != null &&
        inv.due_date < todayStr &&
        Number(inv.balance) > 0,
      ageingBucket: bucket,
      daysOverdue,
    };
  });
}

export async function getInvoiceWithLines(sb: Sb, invoiceId: string) {
  const { data: invoice, error } = await sb
    .from("commercial_invoices")
    .select("*, restaurant_tenants(name, slug)")
    .eq("id", invoiceId)
    .single();
  if (error) throw new Error(error.message);
  const { data: lines, error: linesErr } = await sb
    .from("commercial_invoice_lines")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("sort_order");
  if (linesErr) throw new Error(linesErr.message);
  return { invoice, lines: lines ?? [] };
}

/** Exposed for subscription-lifecycle.server.ts's activation-gate check — never re-exported to the browser. */
export async function hasSuccessfulPayment(sb: Sb, tenantId: string): Promise<boolean> {
  const { count } = await sb
    .from("commercial_payments")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "succeeded");
  return (count ?? 0) > 0;
}
