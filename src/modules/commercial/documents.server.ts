/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P02 §53 — commercial documents (invoices, agreements) rendered for
 * print/PDF/email.
 *
 * Reuses the SAME `RestaurantDocument` shape and `documentToHtml()`
 * renderer every operational document (PO, GRN, receipt...) already uses
 * — one canonical print/PDF layout in the whole codebase, not a second one
 * for commercial documents. It deliberately does NOT go through
 * `documents/core/registry.ts`'s `DOCUMENT_TYPE_IDS`/`documentHeader()`
 * pipeline: that registry is capability-gated for a TENANT's own staff
 * issuing documents about their own operations (header = the tenant's
 * business identity). A commercial invoice is the inverse direction — the
 * platform vendor billing the tenant — so the header must be the VENDOR's
 * identity and the "parties" block must be the tenant, which the existing
 * registry has no way to express without corrupting its one existing
 * meaning. Building the `RestaurantDocument` value directly here and
 * calling the shared renderer keeps the ONE renderer while keeping the
 * (different) authorization and identity model correct.
 */
import { PRODUCT } from "@/config/product";
import { documentToHtml } from "../restaurant/documents/rendering/toHtml";
import type { CellValue, RestaurantDocument } from "../restaurant/documents/core/types";

type Sb = any;

function vendorHeader() {
  return {
    business: PRODUCT.vendor,
    legalName: null,
    property: null,
    outlet: null,
    address: null,
    contact: PRODUCT.supportEmail,
    website: null,
    taxId: null,
    logoUrl: null,
  };
}

export async function buildInvoiceDocument(sb: Sb, invoiceId: string): Promise<RestaurantDocument> {
  const { data: invoice, error } = await sb
    .from("commercial_invoices")
    .select("*, restaurant_tenants(name, settings)")
    .eq("id", invoiceId)
    .single();
  if (error) throw new Error(error.message);
  const { data: lines, error: linesErr } = await sb
    .from("commercial_invoice_lines")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("sort_order");
  if (linesErr) throw new Error(linesErr.message);

  const business =
    (invoice.restaurant_tenants?.settings as { business?: Record<string, unknown> } | null)
      ?.business ?? {};
  const customerName =
    (business.tradingName as string) ||
    (business.legalName as string) ||
    invoice.restaurant_tenants?.name ||
    "Customer";

  return {
    type: "commercial_invoice",
    title: "Invoice",
    number: invoice.invoice_number,
    status: invoice.status.toUpperCase(),
    currency: invoice.currency,
    issuedAt: invoice.issue_date,
    generatedAt: new Date().toISOString(),
    header: vendorHeader(),
    parties: [
      { label: "Billed to", value: customerName, emphasis: true },
      ...(business.email ? [{ label: "Email", value: business.email as string }] : []),
    ],
    meta: [
      {
        label: "Billing period",
        value: invoice.billing_period_start
          ? `${invoice.billing_period_start} — ${invoice.billing_period_end}`
          : "—",
      },
      { label: "Issue date", value: invoice.issue_date ?? "—" },
      { label: "Due date", value: invoice.due_date ?? "—", emphasis: invoice.status === "issued" },
    ],
    tables: [
      {
        title: "Charges",
        columns: [
          { key: "description", label: "Description" },
          { key: "quantity", label: "Qty", format: "number", align: "right" },
          { key: "unit_price", label: "Unit price", format: "money" },
          { key: "amount", label: "Amount", format: "money" },
        ],
        rows: (lines ?? []).map((l: any) => ({
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price,
          amount: l.amount,
        })),
        totalsRow: null,
      },
    ],
    totals: [
      { label: "Subtotal", value: invoice.subtotal, currency: invoice.currency },
      ...(Number(invoice.discount_total) > 0
        ? [
            {
              label: "Discount",
              value: -Number(invoice.discount_total),
              currency: invoice.currency,
            },
          ]
        : []),
      ...(Number(invoice.tax_total) > 0
        ? [{ label: "Tax", value: invoice.tax_total, currency: invoice.currency }]
        : []),
      { label: "Total", value: invoice.total, currency: invoice.currency, emphasis: true },
      { label: "Paid", value: invoice.amount_paid, currency: invoice.currency },
      {
        label: "Balance due",
        value: invoice.balance,
        currency: invoice.currency,
        emphasis: invoice.balance > 0,
      },
    ],
    signatures: [],
    notes: invoice.notes ?? null,
    traceability: invoice.agreement_id
      ? [
          {
            label: "Agreement",
            recordType: "commercial_agreements",
            recordId: invoice.agreement_id,
          },
        ]
      : [],
    audit: [],
    snapshot: invoice.status !== "draft",
    snapshotNote: invoice.status === "draft" ? "Draft — not yet issued." : null,
  };
}

export async function buildAgreementDocument(
  sb: Sb,
  agreementId: string,
): Promise<RestaurantDocument> {
  const { data: agreement, error } = await sb
    .from("commercial_agreements")
    .select(
      "*, restaurant_tenants(name, settings), commercial_plans(name), commercial_programmes(name)",
    )
    .eq("id", agreementId)
    .single();
  if (error) throw new Error(error.message);

  const business =
    (agreement.restaurant_tenants?.settings as { business?: Record<string, unknown> } | null)
      ?.business ?? {};
  const customerName =
    (business.tradingName as string) ||
    (business.legalName as string) ||
    agreement.restaurant_tenants?.name ||
    "Customer";

  const rows: Record<string, CellValue>[] = [
    {
      description: `${agreement.commercial_plans?.name ?? "Plan"} — ${agreement.billing_interval}`,
      quantity: 1,
      unit_price:
        agreement.billing_interval === "annual" ? agreement.annual_price : agreement.monthly_price,
      amount:
        agreement.billing_interval === "annual" ? agreement.annual_price : agreement.monthly_price,
    },
  ];
  if (agreement.additional_property_price != null) {
    rows.push({
      description: "Additional property (each)",
      quantity: null,
      unit_price: agreement.additional_property_price,
      amount: null,
    });
  }
  if (agreement.implementation_fee != null) {
    rows.push({
      description: "Implementation fee (one-time)",
      quantity: 1,
      unit_price: agreement.implementation_fee,
      amount: agreement.implementation_fee,
    });
  }

  return {
    type: "commercial_agreement",
    title: "Commercial Agreement",
    number: agreement.contract_reference,
    status: agreement.status.toUpperCase(),
    currency: agreement.currency,
    issuedAt: agreement.effective_from,
    generatedAt: new Date().toISOString(),
    header: vendorHeader(),
    parties: [{ label: "Customer", value: customerName, emphasis: true }],
    meta: [
      { label: "Plan", value: agreement.commercial_plans?.name ?? "—" },
      { label: "Programme", value: agreement.commercial_programmes?.name ?? "—" },
      { label: "Billing interval", value: agreement.billing_interval },
      { label: "Effective from", value: agreement.effective_from?.slice(0, 10) ?? "—" },
      ...(agreement.discount_pct != null
        ? [{ label: "Discount", value: `${agreement.discount_pct}%` }]
        : []),
    ],
    tables: [
      {
        title: "Contracted terms",
        columns: [
          { key: "description", label: "Item" },
          { key: "quantity", label: "Qty", format: "number", align: "right" },
          { key: "unit_price", label: "Price", format: "money" },
        ],
        rows,
      },
    ],
    totals: [],
    signatures: ["Customer", "Authorized signatory"],
    notes: agreement.agreed_terms ?? null,
    traceability: agreement.renewed_from_agreement_id
      ? [
          {
            label: "Renewed from",
            recordType: "commercial_agreements",
            recordId: agreement.renewed_from_agreement_id,
          },
        ]
      : [],
    audit: [],
    snapshot: agreement.status !== "draft",
    snapshotNote:
      "Contracted terms are frozen at signing — later pricing changes never alter this agreement.",
  };
}

export async function renderCommercialDocumentHtml(
  sb: Sb,
  kind: "invoice" | "agreement",
  id: string,
): Promise<string> {
  const doc =
    kind === "invoice" ? await buildInvoiceDocument(sb, id) : await buildAgreementDocument(sb, id);
  return documentToHtml(doc);
}
