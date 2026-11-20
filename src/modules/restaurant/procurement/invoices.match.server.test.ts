import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn().mockResolvedValue(undefined),
  recordProcurementAudit: vi.fn().mockResolvedValue(undefined),
  raiseVariance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => mocks.assertCapability(...args),
}));

vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./audit.server", () => ({
  recordProcurementAudit: (...args: unknown[]) => mocks.recordProcurementAudit(...args),
  recordProcurementAuditStrict: (...args: unknown[]) => mocks.recordProcurementAudit(...args),
}));

vi.mock("./variances.server", () => ({
  raiseVariance: (...args: unknown[]) => mocks.raiseVariance(...args),
}));

const { matchSupplierInvoice } = await import("./invoices.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const MAKER = "22222222-2222-2222-2222-222222222222";
const PROPERTY = "33333333-3333-3333-3333-333333333333";
const LOCATION = "44444444-4444-4444-4444-444444444444";
const INVOICE = "55555555-5555-5555-5555-555555555555";

function makeSupabase() {
  const invoice = {
    id: INVOICE,
    tenant_id: TENANT,
    supplier_id: null,
    purchase_order_id: null,
    document_number: "INV-001",
    total: 1000,
    currency: "TZS",
    property_id: PROPERTY,
    location_id: LOCATION,
    recorded_by: MAKER,
  };
  let operation = "select";
  type Query = {
    select: (...args: unknown[]) => Query;
    eq: (...args: unknown[]) => Query;
    update: (...args: unknown[]) => Query;
    single: () => Promise<{ data: typeof invoice; error: null }>;
  };
  const builder: Query = {
    select: () => builder,
    eq: () => builder,
    update: () => {
      operation = "update";
      return builder;
    },
    single: async () => ({ data: operation === "select" ? invoice : invoice, error: null }),
  };
  return { from: () => builder } as unknown as Parameters<typeof matchSupplierInvoice>[0];
}

describe("supplier invoice three-way reconciliation maker-checker", () => {
  it("denies the invoice recorder from performing the reconciliation", async () => {
    const sb = makeSupabase();
    await expect(matchSupplierInvoice(sb, MAKER, TENANT, INVOICE)).rejects.toThrow(
      /Separation of duties/,
    );

    expect(mocks.assertCapability).toHaveBeenCalledWith(sb, MAKER, TENANT, "invoice.manage", {
      propertyId: PROPERTY,
      locationId: LOCATION,
    });
    expect(mocks.recordProcurementAudit).not.toHaveBeenCalled();
  });
});

const { setInvoicePaymentStatus } = await import("./invoices.server");
const CHECKER = "66666666-6666-6666-6666-666666666666";

function makeSettlementSupabase(creditApplied = 0) {
  const updates: unknown[] = [];
  const invoice = {
    id: INVOICE,
    payment_status: "unpaid",
    document_number: "INV-001",
    total: 1000,
    amount_paid: 0,
    match_status: "matched",
    property_id: PROPERTY,
    location_id: LOCATION,
    recorded_by: MAKER,
  };
  const sb = {
    from(table: string) {
      let pendingUpdate: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        update: (payload: Record<string, unknown>) => {
          pendingUpdate = payload;
          updates.push(payload);
          return builder;
        },
        single: async () => ({
          data: pendingUpdate ? { id: INVOICE, ...pendingUpdate } : invoice,
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data:
              table === "restaurant_supplier_credit_note_applications" && creditApplied > 0
                ? [{ amount: creditApplied }]
                : [],
            error: null,
          }),
      };
      return builder;
    },
  };
  return { sb: sb as unknown as Parameters<typeof setInvoicePaymentStatus>[0], updates };
}

describe("supplier invoice settlement maker-checker", () => {
  it("denies the invoice recorder from settling the same invoice, writing nothing", async () => {
    const { sb, updates } = makeSettlementSupabase();
    await expect(
      setInvoicePaymentStatus(sb, MAKER, {
        tenantId: TENANT,
        invoiceId: INVOICE,
        paymentStatus: "paid",
      } as never),
    ).rejects.toThrow(/Separation of duties — the invoice recorder cannot settle/);
    expect(updates).toHaveLength(0);
  });

  it("lets a different authorised user settle the balance net of applied supplier credit", async () => {
    const { sb, updates } = makeSettlementSupabase(250);
    await setInvoicePaymentStatus(sb, CHECKER, {
      tenantId: TENANT,
      invoiceId: INVOICE,
      paymentStatus: "paid",
    } as never);
    expect(updates[0]).toMatchObject({ payment_status: "paid", amount_paid: 750 });
  });
});
