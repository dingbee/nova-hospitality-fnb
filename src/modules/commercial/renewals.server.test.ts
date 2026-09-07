import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import { CommercialForbiddenError } from "./access.server";
import { listUpcomingRenewals } from "./renewals.server";

const ADMIN = "admin-1";
const OTHER_USER = "user-2";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const TENANT_C = "tenant-c";

function baseTables(): FakeTables {
  return {
    commercial_administrators: [{ id: "a1", user_id: ADMIN, status: "active" }],
    restaurant_subscriptions: [],
    commercial_property_classifications: [],
    commercial_invoices: [],
  };
}

function db(tables: FakeTables) {
  return createFakeSupabase(tables, {
    restaurant_is_commercial_admin: ({ _user_id }: { _user_id: string }) => _user_id === ADMIN,
  });
}

describe("listUpcomingRenewals", () => {
  it("denies a non-commercial-admin", async () => {
    const sb = db(baseTables());
    await expect(listUpcomingRenewals(sb, OTHER_USER)).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
  });

  it("excludes subscriptions with no renewal date and terminal statuses", async () => {
    const tables = baseTables();
    tables.restaurant_subscriptions.push(
      {
        id: "sub-no-date",
        tenant_id: TENANT_A,
        status: "active",
        renewal_date: null,
        billing_interval: "monthly",
        agreement_id: "agr-a",
        restaurant_tenants: { name: "Amboni Grill", slug: "amboni-grill" },
        commercial_plans: { code: "pro", name: "Pro" },
        commercial_programmes: null,
      },
      {
        id: "sub-cancelled",
        tenant_id: TENANT_B,
        status: "cancelled",
        renewal_date: "2026-07-01",
        billing_interval: "monthly",
        agreement_id: "agr-b",
        restaurant_tenants: { name: "Baraza Bistro", slug: "baraza-bistro" },
        commercial_plans: { code: "core", name: "Core" },
        commercial_programmes: null,
      },
    );
    const sb = db(tables);
    expect(await listUpcomingRenewals(sb, ADMIN)).toEqual([]);
  });

  describe("with a frozen clock", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("surfaces active/renewing/past_due subscriptions ordered by renewal date, with risk and property counts", async () => {
      const tables = baseTables();
      tables.restaurant_subscriptions.push(
        {
          id: "sub-a",
          tenant_id: TENANT_A,
          status: "active",
          renewal_date: "2026-07-15",
          billing_interval: "monthly",
          agreement_id: "agr-a",
          restaurant_tenants: { name: "Amboni Grill", slug: "amboni-grill" },
          commercial_plans: { code: "pro", name: "Pro" },
          commercial_programmes: null,
        },
        {
          id: "sub-b",
          tenant_id: TENANT_B,
          status: "past_due",
          renewal_date: "2026-06-20",
          billing_interval: "monthly",
          agreement_id: "agr-b",
          restaurant_tenants: { name: "Baraza Bistro", slug: "baraza-bistro" },
          commercial_plans: { code: "core", name: "Core" },
          commercial_programmes: null,
        },
        {
          id: "sub-c",
          tenant_id: TENANT_C,
          status: "renewing",
          renewal_date: "2026-06-16",
          billing_interval: "annual",
          agreement_id: "agr-c",
          restaurant_tenants: { name: "Chui Cafe", slug: "chui-cafe" },
          commercial_plans: { code: "pro", name: "Pro" },
          commercial_programmes: { code: "founding_10", name: "Founding 10" },
        },
      );
      tables.commercial_property_classifications.push(
        { tenant_id: TENANT_A, chargeable: false },
        { tenant_id: TENANT_A, chargeable: true },
        { tenant_id: TENANT_A, chargeable: true },
        { tenant_id: TENANT_C, chargeable: false },
      );
      tables.commercial_invoices.push(
        { tenant_id: TENANT_A, balance: 0, status: "paid" },
        { tenant_id: TENANT_B, balance: 75000, status: "issued" },
      );

      const sb = db(tables);
      const rows = await listUpcomingRenewals(sb, ADMIN);

      expect(rows).toHaveLength(3);
      // Ordered by renewal_date ascending.
      expect(rows.map((r) => r.tenantId)).toEqual([TENANT_C, TENANT_B, TENANT_A]);

      const a = rows.find((r) => r.tenantId === TENANT_A)!;
      expect(a.daysUntilRenewal).toBe(30);
      expect(a.propertyCount).toBe(3);
      expect(a.chargeablePropertyCount).toBe(2);
      expect(a.outstandingBalance).toBe(0);
      expect(a.atRisk).toBe(false);

      const b = rows.find((r) => r.tenantId === TENANT_B)!;
      expect(b.atRisk).toBe(true); // past_due status
      expect(b.outstandingBalance).toBe(75000);

      const c = rows.find((r) => r.tenantId === TENANT_C)!;
      expect(c.programmeCode).toBe("founding_10");
      expect(c.planCode).toBe("pro"); // Plan: PRO / Programme: FOUNDING_10, never "Plan: FOUNDING_10"
      expect(c.propertyCount).toBe(1);
      expect(c.chargeablePropertyCount).toBe(0);
    });

    it("flags a customer at risk purely from an outstanding balance, even with an active status", async () => {
      const tables = baseTables();
      tables.restaurant_subscriptions.push({
        id: "sub-a",
        tenant_id: TENANT_A,
        status: "active",
        renewal_date: "2026-07-01",
        billing_interval: "monthly",
        agreement_id: "agr-a",
        restaurant_tenants: { name: "Amboni Grill", slug: "amboni-grill" },
        commercial_plans: { code: "pro", name: "Pro" },
        commercial_programmes: null,
      });
      tables.commercial_invoices.push({ tenant_id: TENANT_A, balance: 10000, status: "issued" });
      const sb = db(tables);
      const rows = await listUpcomingRenewals(sb, ADMIN);
      expect(rows[0].atRisk).toBe(true);
    });
  });
});
