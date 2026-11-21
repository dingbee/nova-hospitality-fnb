/* eslint-disable @typescript-eslint/no-explicit-any -- minimal fake Supabase boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn().mockResolvedValue(undefined),
  assertTenantRead: vi.fn().mockResolvedValue(undefined),
  getTenantScope: vi.fn().mockResolvedValue({ grants: [], platformAdmin: false }),
}));

const { applySupplierCreditNote } = await import("./credit-notes.server");

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOTE = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const INVOICE_MAKER = "44444444-4444-4444-8444-444444444444";
const NOTE_MAKER = "55555555-5555-4555-8555-555555555555";
const CHECKER = "66666666-6666-4666-8666-666666666666";

const rpc = vi.fn();
function sb() {
  const rows: Record<string, any> = {
    restaurant_supplier_credit_notes: {
      id: NOTE,
      supplier_id: "s1",
      currency: "TZS",
      property_id: null,
      location_id: null,
      reference_invoice_id: null,
      recorded_by: NOTE_MAKER,
    },
    restaurant_supplier_invoices: {
      id: INVOICE,
      supplier_id: "s1",
      currency: "TZS",
      property_id: null,
      location_id: null,
      recorded_by: INVOICE_MAKER,
    },
  };
  return {
    from(table: string) {
      const q: any = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: rows[table], error: null }),
      };
      return q;
    },
    rpc,
  };
}

const input = {
  tenantId: TENANT,
  creditNoteId: NOTE,
  invoiceId: INVOICE,
  amount: 10,
  reason: "Supplier credit",
  idempotencyKey: "77777777-7777-4777-8777-777777777777",
};

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { applied: true }, error: null });
});

describe("applySupplierCreditNote — separation of duties", () => {
  it("denies the invoice recorder", async () => {
    await expect(applySupplierCreditNote(sb(), INVOICE_MAKER, input)).rejects.toThrow(
      /invoice recorder cannot apply supplier credit/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denies the credit-note recorder", async () => {
    await expect(applySupplierCreditNote(sb(), NOTE_MAKER, input)).rejects.toThrow(
      /recorded this credit note cannot apply it/,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("lets an independent checker apply credit through the database function", async () => {
    await applySupplierCreditNote(sb(), CHECKER, input);
    expect(rpc).toHaveBeenCalledWith(
      "restaurant_apply_supplier_credit_note",
      expect.objectContaining({ _tenant_id: TENANT, _credit_note_id: NOTE, _invoice_id: INVOICE }),
    );
  });
});
