import { describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import { approveAgreement, cancelAgreement, createAgreement } from "./agreements.server";

const ADMIN = "admin-1";
const NON_ADMIN = "user-1";
const TENANT = "tenant-1";
const PLAN_CORE = "plan-core";
const PLAN_ENTERPRISE = "plan-enterprise";

function baseTables(overrides: Partial<FakeTables> = {}): FakeTables {
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
    ...overrides,
  };
}

function db(tables: FakeTables) {
  return createFakeSupabase(tables, {
    restaurant_is_commercial_admin: ({ _user_id }: { _user_id: string }) => _user_id === ADMIN,
    restaurant_next_document_number: () => "AGR-2026-00001",
  });
}

describe("createAgreement — price snapshot", () => {
  it("copies the live catalogue price onto the agreement at creation time", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await createAgreement(sb, ADMIN, {
      tenantId: TENANT,
      planId: PLAN_CORE,
      billingInterval: "monthly",
      requiresPaymentBeforeActivation: true,
    });
    expect(agreement.monthly_price).toBe(350000);
    expect(agreement.annual_price).toBe(3500000);
    expect(agreement.additional_property_price).toBe(250000);
    expect(agreement.implementation_fee).toBe(750000);
    expect(agreement.status).toBe("draft");
    expect(agreement.contract_reference).toBe("AGR-2026-00001");
  });

  it("is immune to a later catalogue price change — the agreement keeps its own snapshot", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await createAgreement(sb, ADMIN, {
      tenantId: TENANT,
      planId: PLAN_CORE,
      billingInterval: "monthly",
      requiresPaymentBeforeActivation: true,
    });
    // Simulate an admin editing the live catalogue afterward.
    tables.commercial_pricing[0].monthly_price = 999999;
    expect(agreement.monthly_price).toBe(350000);
    // Re-reading the same agreement row must still reflect the frozen price.
    const stillFrozen = tables.commercial_agreements.find((a) => a.id === agreement.id);
    expect(stillFrozen.monthly_price).toBe(350000);
  });

  it("never fabricates a price for a plan with no configured catalogue row (e.g. Enterprise)", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await createAgreement(sb, ADMIN, {
      tenantId: TENANT,
      planId: PLAN_ENTERPRISE,
      billingInterval: "monthly",
      requiresPaymentBeforeActivation: true,
    });
    expect(agreement.monthly_price).toBeNull();
    expect(agreement.annual_price).toBeNull();
  });

  it("computes a flat discount amount from discountPct against the snapshot price", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await createAgreement(sb, ADMIN, {
      tenantId: TENANT,
      planId: PLAN_CORE,
      billingInterval: "monthly",
      discountPct: 10,
      discountReason: "Launch promo",
      requiresPaymentBeforeActivation: true,
    });
    expect(agreement.discount_pct).toBe(10);
    expect(agreement.discount_amount).toBe(35000);
    expect(agreement.discount_reason).toBe("Launch promo");
  });

  it("rejects a non-commercial-admin caller", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await expect(
      createAgreement(sb, NON_ADMIN, {
        tenantId: TENANT,
        planId: PLAN_CORE,
        billingInterval: "monthly",
        requiresPaymentBeforeActivation: true,
      }),
    ).rejects.toThrow(/commercial administration/i);
  });
});

describe("approveAgreement / cancelAgreement", () => {
  it("moves a draft agreement to approved and records who/when", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await createAgreement(sb, ADMIN, {
      tenantId: TENANT,
      planId: PLAN_CORE,
      billingInterval: "monthly",
      requiresPaymentBeforeActivation: true,
    });
    const approved = await approveAgreement(sb, ADMIN, { agreementId: agreement.id });
    expect(approved.status).toBe("approved");
    expect(approved.approved_by).toBe(ADMIN);
    expect(approved.approved_at).toBeTruthy();
  });

  it("refuses to approve an already-cancelled agreement", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await createAgreement(sb, ADMIN, {
      tenantId: TENANT,
      planId: PLAN_CORE,
      billingInterval: "monthly",
      requiresPaymentBeforeActivation: true,
    });
    await cancelAgreement(sb, ADMIN, { agreementId: agreement.id, reason: "Customer withdrew" });
    await expect(approveAgreement(sb, ADMIN, { agreementId: agreement.id })).rejects.toThrow(
      /cancelled/,
    );
  });

  it("cancelling records reason, actor and timestamp", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await createAgreement(sb, ADMIN, {
      tenantId: TENANT,
      planId: PLAN_CORE,
      billingInterval: "monthly",
      requiresPaymentBeforeActivation: true,
    });
    const cancelled = await cancelAgreement(sb, ADMIN, {
      agreementId: agreement.id,
      reason: "Never signed",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellation_reason).toBe("Never signed");
    expect(cancelled.cancelled_by).toBe(ADMIN);
  });
});
