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
});
