import { describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import { recordPayment } from "./payments.server";

const ADMIN = "admin-1";
const TENANT = "tenant-1";
const INVOICE = "invoice-1";

function baseTables(overrides: Partial<FakeTables> = {}): FakeTables {
  return {
    commercial_administrators: [{ id: "a1", user_id: ADMIN, status: "active" }],
    commercial_invoices: [
      {
        id: INVOICE,
        tenant_id: TENANT,
        status: "issued",
        total: 413000,
        amount_paid: 0,
        balance: 413000,
        invoice_number: "INV-2026-00001",
      },
    ],
    commercial_payments: [],
    commercial_billing_accounts: [],
    commercial_notifications: [],
    ...overrides,
  };
}

function db(tables: FakeTables) {
  return createFakeSupabase(tables, {
    restaurant_is_commercial_admin: ({ _user_id }: { _user_id: string }) => _user_id === ADMIN,
  });
}

describe("recordPayment", () => {
  it("applies a full payment and marks the invoice paid", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await recordPayment(sb, ADMIN, {
      invoiceId: INVOICE,
      method: "manual_bank_transfer",
      amount: 413000,
      currency: "TZS",
      idempotencyKey: "key-1",
    });
    const invoice = tables.commercial_invoices.find((i) => i.id === INVOICE);
    expect(invoice.status).toBe("paid");
    expect(invoice.balance).toBe(0);
  });

  it("applies a partial payment and leaves the invoice partially_paid with a reduced balance", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await recordPayment(sb, ADMIN, {
      invoiceId: INVOICE,
      method: "manual_mobile_money",
      amount: 200000,
      currency: "TZS",
      idempotencyKey: "key-2",
    });
    const invoice = tables.commercial_invoices.find((i) => i.id === INVOICE);
    expect(invoice.status).toBe("partially_paid");
    expect(invoice.balance).toBe(213000);
  });

  it("is idempotent — a retried request with the same key does not double-apply", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const first = await recordPayment(sb, ADMIN, {
      invoiceId: INVOICE,
      method: "manual_bank_transfer",
      amount: 100000,
      currency: "TZS",
      idempotencyKey: "same-key",
    });
    const second = await recordPayment(sb, ADMIN, {
      invoiceId: INVOICE,
      method: "manual_bank_transfer",
      amount: 100000,
      currency: "TZS",
      idempotencyKey: "same-key",
    });
    expect(second.id).toBe(first.id);
    expect(tables.commercial_payments.length).toBe(1);
    const invoice = tables.commercial_invoices.find((i) => i.id === INVOICE);
    expect(invoice.amount_paid).toBe(100000); // not 200000
  });

  it("rejects a payment that exceeds the invoice's outstanding balance", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await expect(
      recordPayment(sb, ADMIN, {
        invoiceId: INVOICE,
        method: "manual_bank_transfer",
        amount: 999999,
        currency: "TZS",
        idempotencyKey: "key-3",
      }),
    ).rejects.toThrow(/exceeds/);
    const invoice = tables.commercial_invoices.find((i) => i.id === INVOICE);
    expect(invoice.balance).toBe(413000); // untouched
  });

  it("refuses to record a payment against a draft invoice", async () => {
    const tables = baseTables({
      commercial_invoices: [{ ...baseTables().commercial_invoices[0], status: "draft" }],
    });
    const sb = db(tables);
    await expect(
      recordPayment(sb, ADMIN, {
        invoiceId: INVOICE,
        method: "manual_cash",
        amount: 1000,
        currency: "TZS",
        idempotencyKey: "key-4",
      }),
    ).rejects.toThrow(/status "draft"/);
  });

  it("rejects a non-commercial-admin caller — payment state can never be forged by a tenant user", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await expect(
      recordPayment(sb, "some-tenant-user", {
        invoiceId: INVOICE,
        method: "manual_cash",
        amount: 1000,
        currency: "TZS",
        idempotencyKey: "key-5",
      }),
    ).rejects.toThrow(/commercial administration/i);
    const invoice = tables.commercial_invoices.find((i) => i.id === INVOICE);
    expect(invoice.balance).toBe(413000);
  });
});
