import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import { CommercialForbiddenError } from "./access.server";
import { listCollections } from "./collections.server";

const ADMIN = "admin-1";
const OTHER_USER = "user-2";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function baseTables(): FakeTables {
  return {
    commercial_administrators: [{ id: "a1", user_id: ADMIN, status: "active" }],
    commercial_invoices: [],
    restaurant_subscriptions: [],
  };
}

function db(tables: FakeTables) {
  return createFakeSupabase(tables, {
    restaurant_is_commercial_admin: ({ _user_id }: { _user_id: string }) => _user_id === ADMIN,
  });
}

describe("listCollections", () => {
  it("denies a non-commercial-admin", async () => {
    const sb = db(baseTables());
    await expect(listCollections(sb, OTHER_USER)).rejects.toBeInstanceOf(CommercialForbiddenError);
  });

  it("returns an empty list when nothing is issued or partially paid", async () => {
    const tables = baseTables();
    tables.commercial_invoices.push({
      id: "inv-paid",
      tenant_id: TENANT_A,
      status: "paid",
      due_date: "2026-01-01",
      total: 100,
      amount_paid: 100,
      balance: 0,
      invoice_number: "INV-1",
      restaurant_tenants: { name: "Amboni Grill", slug: "amboni-grill" },
    });
    const sb = db(tables);
    expect(await listCollections(sb, ADMIN)).toEqual([]);
  });

  describe("with a frozen clock", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("only surfaces issued/partially_paid invoices, with ageing computed from due_date", async () => {
      const tables = baseTables();
      tables.commercial_invoices.push(
        {
          id: "inv-current",
          tenant_id: TENANT_A,
          status: "issued",
          due_date: "2026-07-01",
          total: 100,
          amount_paid: 0,
          balance: 100,
          invoice_number: "INV-CUR",
          restaurant_tenants: { name: "Amboni Grill", slug: "amboni-grill" },
        },
        {
          id: "inv-overdue-30",
          tenant_id: TENANT_A,
          status: "partially_paid",
          due_date: "2026-06-01",
          total: 200,
          amount_paid: 50,
          balance: 150,
          invoice_number: "INV-30",
          restaurant_tenants: { name: "Amboni Grill", slug: "amboni-grill" },
        },
        {
          id: "inv-overdue-90plus",
          tenant_id: TENANT_B,
          status: "issued",
          due_date: "2026-01-01",
          total: 300,
          amount_paid: 0,
          balance: 300,
          invoice_number: "INV-90",
          restaurant_tenants: { name: "Baraza Bistro", slug: "baraza-bistro" },
        },
        {
          id: "inv-void",
          tenant_id: TENANT_B,
          status: "void",
          due_date: "2026-01-01",
          total: 400,
          amount_paid: 0,
          balance: 400,
          invoice_number: "INV-VOID",
          restaurant_tenants: { name: "Baraza Bistro", slug: "baraza-bistro" },
        },
      );
      tables.restaurant_subscriptions.push(
        { tenant_id: TENANT_A, renewal_date: "2026-12-01", status: "active" },
        { tenant_id: TENANT_B, renewal_date: "2026-08-01", status: "past_due" },
      );

      const sb = db(tables);
      const rows = await listCollections(sb, ADMIN);

      expect(rows.map((r) => r.invoiceId)).not.toContain("inv-void");
      expect(rows).toHaveLength(3);

      // Sorted most-overdue-first.
      expect(rows[0].invoiceId).toBe("inv-overdue-90plus");
      expect(rows[0].ageingBucket).toBe("90+");
      expect(rows[0].customerName).toBe("Baraza Bistro");
      expect(rows[0].renewalDate).toBe("2026-08-01");
      expect(rows[0].subscriptionStatus).toBe("past_due");

      expect(rows[1].invoiceId).toBe("inv-overdue-30");
      expect(rows[1].ageingBucket).toBe("1-30");
      expect(rows[1].daysOverdue).toBe(14);

      expect(rows[2].invoiceId).toBe("inv-current");
      expect(rows[2].ageingBucket).toBe("current");
      expect(rows[2].daysOverdue).toBe(0);
    });
  });
});
