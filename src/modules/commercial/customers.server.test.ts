import { describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import { CommercialForbiddenError } from "./access.server";
import { addCommercialNote, getCustomerCommercialProfile, listCustomers } from "./customers.server";

const ADMIN = "admin-1";
const OTHER_USER = "user-2";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function baseTables(): FakeTables {
  return {
    commercial_administrators: [{ id: "a1", user_id: ADMIN, status: "active" }],
    restaurant_tenants: [
      { id: TENANT_A, name: "Amboni Grill", slug: "amboni-grill", settings: {} },
      { id: TENANT_B, name: "Baraza Bistro", slug: "baraza-bistro", settings: {} },
    ],
    commercial_billing_accounts: [
      {
        id: "ba-a",
        tenant_id: TENANT_A,
        commercial_status: "active",
        billing_contact_email: "a@amboni.test",
      },
      {
        id: "ba-b",
        tenant_id: TENANT_B,
        commercial_status: "suspended",
        billing_contact_email: "b@baraza.test",
      },
    ],
    restaurant_subscriptions: [
      {
        id: "sub-a",
        tenant_id: TENANT_A,
        status: "active",
        renewal_date: "2026-12-01",
        agreement_id: "agr-a",
        commercial_plans: { code: "pro", name: "Pro" },
        commercial_programmes: null,
      },
      {
        id: "sub-b",
        tenant_id: TENANT_B,
        status: "suspended",
        renewal_date: "2026-06-01",
        agreement_id: "agr-b",
        commercial_plans: { code: "core", name: "Core" },
        commercial_programmes: null,
      },
    ],
    commercial_invoices: [
      { id: "inv-a1", tenant_id: TENANT_A, balance: 0, status: "paid" },
      { id: "inv-b1", tenant_id: TENANT_B, balance: 150000, status: "issued" },
    ],
    commercial_agreements: [
      {
        id: "agr-a",
        tenant_id: TENANT_A,
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        commercial_plans: { code: "pro", name: "Pro" },
        commercial_programmes: null,
      },
    ],
    commercial_property_classifications: [],
    commercial_payments: [],
    commercial_audit_log: [],
  };
}

function db(tables: FakeTables) {
  return createFakeSupabase(tables, {
    restaurant_is_commercial_admin: ({ _user_id }: { _user_id: string }) => _user_id === ADMIN,
  });
}

describe("listCustomers", () => {
  it("denies a non-commercial-admin", async () => {
    const sb = db(baseTables());
    await expect(listCustomers(sb, OTHER_USER, {})).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
  });

  it("lists every tenant enriched with billing status, plan, and balance", async () => {
    const sb = db(baseTables());
    const rows = await listCustomers(sb, ADMIN, {});
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.tenantId === TENANT_A)!;
    expect(a.commercialStatus).toBe("active");
    expect(a.planCode).toBe("pro");
    expect(a.balance).toBe(0);
    expect(a.hasAgreement).toBe(true);
    const b = rows.find((r) => r.tenantId === TENANT_B)!;
    expect(b.commercialStatus).toBe("suspended");
    expect(b.balance).toBe(150000);
  });

  it("filters server-side by name search", async () => {
    const sb = db(baseTables());
    const rows = await listCustomers(sb, ADMIN, { search: "amboni" });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(TENANT_A);
  });

  it("filters by commercial status", async () => {
    const sb = db(baseTables());
    const rows = await listCustomers(sb, ADMIN, { status: "suspended" });
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(TENANT_B);
  });

  it("defaults an unbilled tenant (no billing account row) to prospect with zero balance", async () => {
    const tables = baseTables();
    tables.restaurant_tenants.push({
      id: "tenant-c",
      name: "Chui Cafe",
      slug: "chui-cafe",
      settings: {},
    });
    const sb = db(tables);
    const rows = await listCustomers(sb, ADMIN, {});
    const c = rows.find((r) => r.tenantId === "tenant-c")!;
    expect(c.commercialStatus).toBe("prospect");
    expect(c.balance).toBe(0);
    expect(c.subscriptionStatus).toBeNull();
  });
});

describe("getCustomerCommercialProfile", () => {
  it("denies a non-commercial-admin", async () => {
    const sb = db(baseTables());
    await expect(getCustomerCommercialProfile(sb, OTHER_USER, TENANT_A)).rejects.toBeInstanceOf(
      CommercialForbiddenError,
    );
  });

  it("throws for an unknown tenant", async () => {
    const sb = db(baseTables());
    await expect(getCustomerCommercialProfile(sb, ADMIN, "no-such-tenant")).rejects.toThrow(
      /not found/i,
    );
  });

  it("assembles tenant, billing account, subscription, agreements, invoices, payments, activity and balance in one read", async () => {
    const sb = db(baseTables());
    const profile = await getCustomerCommercialProfile(sb, ADMIN, TENANT_A);
    expect(profile.tenant.name).toBe("Amboni Grill");
    expect(profile.billingAccount?.commercial_status).toBe("active");
    expect(profile.subscription?.id).toBe("sub-a");
    expect(profile.currentAgreement?.id).toBe("agr-a");
    expect(profile.agreements).toHaveLength(1);
    expect(profile.invoices).toHaveLength(1);
    expect(profile.balance).toBe(0);
  });

  it("computes balance identically to listCustomers' authoritative calculation (same formula, same result)", async () => {
    const sb = db(baseTables());
    const profile = await getCustomerCommercialProfile(sb, ADMIN, TENANT_B);
    const rows = await listCustomers(sb, ADMIN, {});
    const listed = rows.find((r) => r.tenantId === TENANT_B)!;
    expect(profile.balance).toBe(listed.balance);
  });

  it("excludes void/cancelled invoices from the balance", async () => {
    const tables = baseTables();
    tables.commercial_invoices.push({
      id: "inv-a2",
      tenant_id: TENANT_A,
      balance: 999999,
      status: "void",
    });
    const sb = db(tables);
    const profile = await getCustomerCommercialProfile(sb, ADMIN, TENANT_A);
    expect(profile.balance).toBe(0);
  });
});

describe("addCommercialNote", () => {
  it("denies a non-commercial-admin", async () => {
    const sb = db(baseTables());
    await expect(
      addCommercialNote(sb, OTHER_USER, { tenantId: TENANT_A, note: "Called about renewal" }),
    ).rejects.toBeInstanceOf(CommercialForbiddenError);
  });

  it("writes the note to the existing commercial audit trail rather than a new table", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const result = await addCommercialNote(sb, ADMIN, {
      tenantId: TENANT_A,
      note: "Customer requested an invoice copy.",
    });
    expect(result.ok).toBe(true);
    expect(tables.commercial_audit_log).toHaveLength(1);
    const entry = tables.commercial_audit_log[0];
    expect(entry.action).toBe("note");
    expect(entry.tenant_id).toBe(TENANT_A);
    expect(entry.reason).toBe("Customer requested an invoice copy.");
    expect(entry.actor_id).toBe(ADMIN);
  });
});
