/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase client is untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeTables } from "./test-helpers/fakeSupabase";
import { createAgreement, approveAgreement } from "./agreements.server";
import {
  activateSubscription,
  cancelSubscription,
  reactivateSubscription,
  renewSubscription,
  suspendSubscription,
} from "./subscription-lifecycle.server";

const ADMIN = "admin-1";
const TENANT = "tenant-1";
const PLAN_CORE = "plan-core";
const PLAN_PRO = "plan-pro";

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
      {
        id: "price-pro",
        plan_id: PLAN_PRO,
        programme_id: null,
        status: "active",
        effective_from: "2020-01-01T00:00:00Z",
        effective_until: null,
        currency: "TZS",
        monthly_price: 650000,
        annual_price: 6500000,
        additional_property_price: 400000,
        implementation_fee: 1000000,
        tax_treatment: "exclusive",
        tax_rate_pct: 18,
      },
    ],
    commercial_agreements: [],
    restaurant_subscriptions: [],
    commercial_billing_accounts: [],
    commercial_payments: [],
    commercial_notifications: [],
  };
}

function db(tables: FakeTables) {
  return createFakeSupabase(tables, {
    restaurant_is_commercial_admin: ({ _user_id }: { _user_id: string }) => _user_id === ADMIN,
    restaurant_next_document_number: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `AGR-2026-${String(n).padStart(5, "0")}`;
      };
    })(),
  });
}

async function draftAgreement(sb: any, requiresPayment = true) {
  return createAgreement(sb, ADMIN, {
    tenantId: TENANT,
    planId: PLAN_CORE,
    billingInterval: "monthly",
    requiresPaymentBeforeActivation: requiresPayment,
  });
}

describe("activateSubscription — §29 activation gate", () => {
  it("refuses activation when the agreement is not approved", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await draftAgreement(sb);
    await expect(activateSubscription(sb, ADMIN, { agreementId: agreement.id })).rejects.toThrow(
      /not approved/,
    );
  });

  it("refuses activation when payment is required but none is on record", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await draftAgreement(sb, true);
    await approveAgreement(sb, ADMIN, { agreementId: agreement.id });
    await expect(activateSubscription(sb, ADMIN, { agreementId: agreement.id })).rejects.toThrow(
      /requires a recorded payment/,
    );
  });

  it("activates when payment is required and a succeeded payment exists", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await draftAgreement(sb, true);
    await approveAgreement(sb, ADMIN, { agreementId: agreement.id });
    tables.commercial_payments.push({ id: "p1", tenant_id: TENANT, status: "succeeded" });

    const subscription = await activateSubscription(sb, ADMIN, { agreementId: agreement.id });
    expect(subscription.status).toBe("active");
    expect(subscription.agreement_id).toBe(agreement.id);
    expect(subscription.plan_id).toBe(PLAN_CORE);

    const account = tables.commercial_billing_accounts.find((a) => a.tenant_id === TENANT);
    expect(account?.commercial_status).toBe("active");

    const refreshedAgreement = tables.commercial_agreements.find((a) => a.id === agreement.id);
    expect(refreshedAgreement.status).toBe("active");
    expect(refreshedAgreement.subscription_id).toBe(subscription.id);
  });

  it("activates without a payment when the agreement does not require one", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await draftAgreement(sb, false);
    await approveAgreement(sb, ADMIN, { agreementId: agreement.id });
    const subscription = await activateSubscription(sb, ADMIN, { agreementId: agreement.id });
    expect(subscription.status).toBe("active");
  });
});

describe("suspend / reactivate / cancel", () => {
  async function activeSubscription(sb: any, tables: FakeTables) {
    const agreement = await draftAgreement(sb, false);
    await approveAgreement(sb, ADMIN, { agreementId: agreement.id });
    return activateSubscription(sb, ADMIN, { agreementId: agreement.id });
  }

  it("suspends an active subscription and reflects it on the billing account", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await activeSubscription(sb, tables);
    const suspended = await suspendSubscription(sb, ADMIN, { tenantId: TENANT, reason: "Overdue" });
    expect(suspended.status).toBe("suspended");
    const account = tables.commercial_billing_accounts.find((a) => a.tenant_id === TENANT);
    expect(account?.commercial_status).toBe("suspended");
  });

  it("reactivates a suspended subscription", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await activeSubscription(sb, tables);
    await suspendSubscription(sb, ADMIN, { tenantId: TENANT, reason: "Overdue" });
    const reactivated = await reactivateSubscription(sb, ADMIN, {
      tenantId: TENANT,
      reason: "Paid up",
    });
    expect(reactivated.status).toBe("active");
  });

  it("refuses to reactivate a cancelled subscription", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await activeSubscription(sb, tables);
    await cancelSubscription(sb, ADMIN, { tenantId: TENANT, reason: "Churned" });
    await expect(
      reactivateSubscription(sb, ADMIN, { tenantId: TENANT, reason: "test" }),
    ).rejects.toThrow(/cancelled subscription cannot be reactivated/);
  });

  it("cancelling preserves the subscription row (never deletes operational commercial history)", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await activeSubscription(sb, tables);
    await cancelSubscription(sb, ADMIN, { tenantId: TENANT, reason: "Churned" });
    expect(tables.restaurant_subscriptions.length).toBe(1);
    const row = tables.restaurant_subscriptions[0];
    expect(row.status).toBe("cancelled");
    expect(row.cancellation_reason).toBe("Churned");
  });
});

describe("renewSubscription — §24 renewal never mutates the live agreement", () => {
  it("creates a NEW agreement snapshotting current pricing, supersedes the old one, and rolls the subscription onto it", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await draftAgreement(sb, false);
    await approveAgreement(sb, ADMIN, { agreementId: agreement.id });
    const subscription = await activateSubscription(sb, ADMIN, { agreementId: agreement.id });

    const { subscription: renewedSub, agreement: renewedAgreement } = await renewSubscription(
      sb,
      ADMIN,
      {
        tenantId: TENANT,
        keepDiscount: false,
        reason: "Annual renewal",
      },
    );

    expect(renewedAgreement.id).not.toBe(agreement.id);
    expect(renewedAgreement.renewed_from_agreement_id).toBe(agreement.id);
    expect(renewedAgreement.status).toBe("active");
    expect(renewedSub.agreement_id).toBe(renewedAgreement.id);
    expect(renewedSub.id).toBe(subscription.id); // same subscription row, rolled onto the new agreement

    const original = tables.commercial_agreements.find((a) => a.id === agreement.id);
    expect(original.status).toBe("superseded");
    // The superseded agreement's own historical price is untouched.
    expect(original.monthly_price).toBe(350000);
  });

  it("refuses to renew a tenant with no current subscription", async () => {
    const tables = baseTables();
    const sb = db(tables);
    await expect(
      renewSubscription(sb, ADMIN, { tenantId: TENANT, keepDiscount: false }),
    ).rejects.toThrow(/no subscription found/i);
  });

  it("§14 UPGRADE — a renewal with newPlanId snapshots the NEW plan's pricing, while the old agreement's historical terms remain untouched", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await draftAgreement(sb, false);
    await approveAgreement(sb, ADMIN, { agreementId: agreement.id });
    await activateSubscription(sb, ADMIN, { agreementId: agreement.id });

    const { subscription: renewedSub, agreement: renewedAgreement } = await renewSubscription(
      sb,
      ADMIN,
      { tenantId: TENANT, keepDiscount: false, newPlanId: PLAN_PRO, reason: "Upgrade to Pro" },
    );

    expect(renewedAgreement.plan_id).toBe(PLAN_PRO);
    expect(renewedAgreement.monthly_price).toBe(650000); // the NEW plan's catalogue price, snapshotted fresh
    expect(renewedSub.plan_id).toBe(PLAN_PRO);

    const original = tables.commercial_agreements.find((a) => a.id === agreement.id);
    expect(original.status).toBe("superseded");
    expect(original.plan_id).toBe(PLAN_CORE);
    expect(original.monthly_price).toBe(350000); // historical terms never rewritten
  });

  it("§14 DOWNGRADE — a renewal onto a cheaper plan is the identical code path", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const proAgreement = await createAgreement(sb, ADMIN, {
      tenantId: TENANT,
      planId: PLAN_PRO,
      billingInterval: "monthly",
      requiresPaymentBeforeActivation: false,
    });
    await approveAgreement(sb, ADMIN, { agreementId: proAgreement.id });
    await activateSubscription(sb, ADMIN, { agreementId: proAgreement.id });

    const { agreement: renewedAgreement } = await renewSubscription(sb, ADMIN, {
      tenantId: TENANT,
      keepDiscount: false,
      newPlanId: PLAN_CORE,
      reason: "Downgrade to Core",
    });

    expect(renewedAgreement.plan_id).toBe(PLAN_CORE);
    expect(renewedAgreement.monthly_price).toBe(350000);
  });

  it("§14 CONTRACT CHANGE — a renewal with only newDiscountPct keeps the same plan and snapshots the new discount", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await draftAgreement(sb, false);
    await approveAgreement(sb, ADMIN, { agreementId: agreement.id });
    await activateSubscription(sb, ADMIN, { agreementId: agreement.id });

    const { agreement: renewedAgreement } = await renewSubscription(sb, ADMIN, {
      tenantId: TENANT,
      keepDiscount: false,
      newDiscountPct: 10,
      discountReason: "Loyalty discount",
      reason: "Contract change",
    });

    expect(renewedAgreement.plan_id).toBe(PLAN_CORE); // plan unchanged
    expect(renewedAgreement.discount_pct).toBe(10);
    expect(renewedAgreement.discount_reason).toBe("Loyalty discount");
  });

  it("omitting every override still behaves like a plain P02 like-for-like renewal (regression-safe)", async () => {
    const tables = baseTables();
    const sb = db(tables);
    const agreement = await draftAgreement(sb, false);
    await approveAgreement(sb, ADMIN, { agreementId: agreement.id });
    await activateSubscription(sb, ADMIN, { agreementId: agreement.id });

    const { agreement: renewedAgreement } = await renewSubscription(sb, ADMIN, {
      tenantId: TENANT,
      keepDiscount: false,
      reason: "Annual renewal",
    });

    expect(renewedAgreement.plan_id).toBe(PLAN_CORE);
    expect(renewedAgreement.programme_id).toBeNull();
    expect(renewedAgreement.discount_pct).toBeNull();
  });
});
