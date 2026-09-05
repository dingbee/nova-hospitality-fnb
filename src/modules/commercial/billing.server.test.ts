/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase client is untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import { createAgreement, approveAgreement } from "./agreements.server";
import { generateInvoice, issueInvoice, recordPropertyCharge, voidInvoice } from "./billing.server";

const ADMIN = "admin-1";
const TENANT = "tenant-1";
const PLAN_CORE = "plan-core";
const PROP_CLASS = "class-1";
const PROPERTY = "property-1";

function baseTables(): FakeTables {
  return {
    commercial_administrators: [{ id: "a1", user_id: ADMIN, status: "active" }],
    commercial_pricing: [
      {
        id: "price-core",
        plan_id: PLAN_CORE,
        programme_id: null,
        status: "active",
        effective_from: "2020-01-01T00:00:00Z",
        effective_until: null,
        currency: "TZS",
        monthly_price: 350000,
        annual_price: 3500000,
        additional_property_price: 250000,
        implementation_fee: 750000,
        tax_treatment: "exclusive",
        tax_rate_pct: 18,
      },
    ],
    commercial_agreements: [],
    commercial_invoices: [],
    commercial_invoice_lines: [],
    commercial_property_classifications: [],
    commercial_property_policies: [
      { id: "pol-1", plan_id: PLAN_CORE, status: "active", proration_policy: "full_period" },
    ],
    commercial_notifications: [],
    commercial_billing_accounts: [],
  };
}

function db(tables: FakeTables, invoiceSeq = { n: 0 }) {
  return createFakeSupabase(tables, {
    restaurant_is_commercial_admin: ({ _user_id }: { _user_id: string }) => _user_id === ADMIN,
    restaurant_next_document_number: ({ _prefix }: { _prefix: string }) => {
      invoiceSeq.n += 1;
      return `${_prefix}-2026-${String(invoiceSeq.n).padStart(5, "0")}`;
    },
  });
}

async function approvedAgreement(sb: any, discountPct?: number) {
  const agreement = await createAgreement(sb, ADMIN, {
    tenantId: TENANT,
    planId: PLAN_CORE,
    billingInterval: "monthly",
    requiresPaymentBeforeActivation: true,
    discountPct,
    discountReason: discountPct ? "Test discount" : undefined,
  });
  return approveAgreement(sb, ADMIN, { agreementId: agreement.id });
}

describe("generateInvoice — calculation engine", () => {
  it("bills the base subscription price from the agreement snapshot, not the live catalogue", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await approvedAgreement(sb);
    tables.commercial_pricing[0].monthly_price = 999999; // catalogue changes after agreement signed

    const invoice = await generateInvoice(sb, ADMIN, {
      tenantId: TENANT,
      billingPeriodStart: "2026-03-01",
      billingPeriodEnd: "2026-03-31",
      includeImplementationFee: false,
    });
    expect(invoice.subtotal).toBe(350000);
    const lines = tables.commercial_invoice_lines.filter((l) => l.invoice_id === invoice.id);
    const base = lines.find((l) => l.kind === "base_subscription");
    expect(base?.amount).toBe(350000);
  });

  it("computes tax exclusive of the subtotal using the agreement's snapshot tax rate", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await approvedAgreement(sb);
    const invoice = await generateInvoice(sb, ADMIN, {
      tenantId: TENANT,
      billingPeriodStart: "2026-03-01",
      billingPeriodEnd: "2026-03-31",
      includeImplementationFee: false,
    });
    expect(invoice.subtotal).toBe(350000);
    expect(invoice.tax_total).toBe(63000); // 18% of 350000
    expect(invoice.total).toBe(413000);
  });

  it("applies a percentage discount before tax", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await approvedAgreement(sb, 10);
    const invoice = await generateInvoice(sb, ADMIN, {
      tenantId: TENANT,
      billingPeriodStart: "2026-03-01",
      billingPeriodEnd: "2026-03-31",
      includeImplementationFee: false,
    });
    // 350000 - 10% = 315000; tax 18% of 315000 = 56700; total = 371700.
    expect(invoice.discount_total).toBe(35000);
    expect(invoice.tax_total).toBe(56700);
    expect(invoice.total).toBe(371700);
  });

  it("includes the implementation fee only once, never on a second invoice for the same agreement", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await approvedAgreement(sb);
    const first = await generateInvoice(sb, ADMIN, {
      tenantId: TENANT,
      billingPeriodStart: "2026-03-01",
      billingPeriodEnd: "2026-03-31",
      includeImplementationFee: true,
    });
    const firstLines = tables.commercial_invoice_lines.filter((l) => l.invoice_id === first.id);
    expect(firstLines.some((l) => l.kind === "implementation")).toBe(true);

    const second = await generateInvoice(sb, ADMIN, {
      tenantId: TENANT,
      billingPeriodStart: "2026-04-01",
      billingPeriodEnd: "2026-04-30",
      includeImplementationFee: true,
    });
    const secondLines = tables.commercial_invoice_lines.filter((l) => l.invoice_id === second.id);
    expect(secondLines.some((l) => l.kind === "implementation")).toBe(false);
  });

  it("refuses to invoice when the agreement has no configured price and there is nothing else to bill", async () => {
    const tables = baseTables();
    tables.commercial_pricing = []; // Enterprise-style: no catalogue price at all
    const sb = db(tables);
    await approvedAgreement(sb);
    await expect(
      generateInvoice(sb, ADMIN, {
        tenantId: TENANT,
        billingPeriodStart: "2026-03-01",
        billingPeriodEnd: "2026-03-31",
        includeImplementationFee: false,
      }),
    ).rejects.toThrow(/nothing to invoice/i);
  });

  it("rejects a non-commercial-admin caller", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await approvedAgreement(sb);
    await expect(
      generateInvoice(sb, "not-an-admin", {
        tenantId: TENANT,
        billingPeriodStart: "2026-03-01",
        billingPeriodEnd: "2026-03-31",
        includeImplementationFee: false,
      }),
    ).rejects.toThrow(/commercial administration/i);
  });
});

describe("recordPropertyCharge — §12 property classification → invoice", () => {
  it("creates a draft invoice for a chargeable property classification", async () => {
    const tables = baseTables();
    tables.commercial_property_classifications.push({
      id: PROP_CLASS,
      tenant_id: TENANT,
      property_id: PROPERTY,
      chargeable: true,
      price_applied: 250000,
      currency: "TZS",
      restaurant_properties: { name: "Second Outlet" },
    });
    const sb = db(tables);
    const invoice = await recordPropertyCharge(sb, ADMIN, TENANT, PROP_CLASS);
    expect(invoice).not.toBeNull();
    expect(invoice.status).toBe("draft");
    expect(invoice.total).toBe(250000);
    const line = tables.commercial_invoice_lines.find((l) => l.source_id === PROP_CLASS);
    expect(line?.description).toContain("Second Outlet");
  });

  it("is idempotent — a retried call for the same classification does not create a second invoice", async () => {
    const tables = baseTables();
    tables.commercial_property_classifications.push({
      id: PROP_CLASS,
      tenant_id: TENANT,
      property_id: PROPERTY,
      chargeable: true,
      price_applied: 250000,
      currency: "TZS",
      restaurant_properties: { name: "Second Outlet" },
    });
    const sb = db(tables);
    await recordPropertyCharge(sb, ADMIN, TENANT, PROP_CLASS);
    const second = await recordPropertyCharge(sb, ADMIN, TENANT, PROP_CLASS);
    expect(second).toBeNull();
    expect(tables.commercial_invoices.length).toBe(1);
  });

  it("never fabricates a charge when no price was applied at classification", async () => {
    const tables = baseTables();
    tables.commercial_property_classifications.push({
      id: PROP_CLASS,
      tenant_id: TENANT,
      property_id: PROPERTY,
      chargeable: false,
      price_applied: null,
      currency: "TZS",
      restaurant_properties: { name: "Included Outlet" },
    });
    const sb = db(tables);
    const invoice = await recordPropertyCharge(sb, ADMIN, TENANT, PROP_CLASS);
    expect(invoice).toBeNull();
    expect(tables.commercial_invoices.length).toBe(0);
  });
});

describe("issueInvoice / voidInvoice", () => {
  it("issuing sets issue/due dates and moves status to issued", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await approvedAgreement(sb);
    const invoice = await generateInvoice(sb, ADMIN, {
      tenantId: TENANT,
      billingPeriodStart: "2026-03-01",
      billingPeriodEnd: "2026-03-31",
      includeImplementationFee: false,
    });
    const issued = await issueInvoice(sb, ADMIN, { invoiceId: invoice.id });
    expect(issued.status).toBe("issued");
    expect(issued.issue_date).toBeTruthy();
    expect(issued.due_date).toBeTruthy();
  });

  it("refuses to issue an invoice that isn't a draft", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await approvedAgreement(sb);
    const invoice = await generateInvoice(sb, ADMIN, {
      tenantId: TENANT,
      billingPeriodStart: "2026-03-01",
      billingPeriodEnd: "2026-03-31",
      includeImplementationFee: false,
    });
    await issueInvoice(sb, ADMIN, { invoiceId: invoice.id });
    await expect(issueInvoice(sb, ADMIN, { invoiceId: invoice.id })).rejects.toThrow(
      /status "issued"/,
    );
  });

  it("refuses to void a fully paid invoice", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await approvedAgreement(sb);
    const invoice = await generateInvoice(sb, ADMIN, {
      tenantId: TENANT,
      billingPeriodStart: "2026-03-01",
      billingPeriodEnd: "2026-03-31",
      includeImplementationFee: false,
    });
    await issueInvoice(sb, ADMIN, { invoiceId: invoice.id });
    const row = tables.commercial_invoices.find((i) => i.id === invoice.id);
    row.status = "paid";
    await expect(voidInvoice(sb, ADMIN, { invoiceId: invoice.id, reason: "test" })).rejects.toThrow(
      /paid/i,
    );
  });
});
