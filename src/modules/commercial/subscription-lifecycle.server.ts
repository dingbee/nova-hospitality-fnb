/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * P02 §7-8, §24-26 — subscription lifecycle: activation, renewal,
 * cancellation, suspension. Every transition here writes
 * `restaurant_subscriptions` (the ONE current-subscription row per tenant,
 * reused from P01/0001) plus `commercial_billing_accounts.commercial_status`
 * and the commercial audit trail — never a parallel status concept.
 */
import { assertCommercialAdmin } from "./access.server";
import { writeCommercialAudit } from "./audit.server";
import { approveAgreement, createAgreement, getAgreement } from "./agreements.server";
import { setCommercialStatus } from "./billing-account.server";
import { currentBillingPeriod } from "./billing-period";
import { hasSuccessfulPayment } from "./billing.server";
import type {
  ActivateSubscriptionInput,
  CancelSubscriptionInput,
  ReactivateSubscriptionInput,
  RenewSubscriptionInput,
  SuspendSubscriptionInput,
} from "./contracts";
import { sendCommercialNotification } from "./notifications.server";

type Sb = any;

async function loadSubscription(sb: Sb, tenantId: string) {
  const { data, error } = await sb
    .from("restaurant_subscriptions")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

function renewalDateFor(effectiveFrom: string, billingInterval: string): string {
  const period = currentBillingPeriod(
    new Date(effectiveFrom),
    billingInterval as "monthly" | "annual" | "custom",
    new Date(),
  );
  return period.end.toISOString().slice(0, 10);
}

/**
 * §29 activation gate: Agreement approved + effective date reached +
 * (if the agreement requires it) at least one successful payment on
 * record. This is a deliberately simpler test than "the first invoice is
 * fully paid" — the spec's own illustrative formula does not demand that
 * either, and a stricter rule can be tightened later without a schema
 * change. Stated here rather than silently narrowing scope.
 */
async function assertCanActivate(sb: Sb, agreement: any): Promise<void> {
  if (agreement.status !== "approved") {
    throw new Error(
      `Agreement "${agreement.contract_reference}" is not approved (status: ${agreement.status}).`,
    );
  }
  if (new Date(agreement.effective_from).getTime() > Date.now()) {
    throw new Error(
      `Agreement "${agreement.contract_reference}" is not yet effective (effective ${agreement.effective_from}).`,
    );
  }
  if (agreement.requires_payment_before_activation) {
    const paid = await hasSuccessfulPayment(sb, agreement.tenant_id);
    if (!paid) {
      throw new Error(
        `Agreement "${agreement.contract_reference}" requires a recorded payment before activation.`,
      );
    }
  }
}

export async function activateSubscription(
  sb: Sb,
  userId: string,
  input: ActivateSubscriptionInput,
) {
  await assertCommercialAdmin(sb, userId);
  const agreement = await getAgreement(sb, input.agreementId);
  if (!agreement) throw new Error("Agreement not found.");
  await assertCanActivate(sb, agreement);

  const existing = await loadSubscription(sb, agreement.tenant_id);
  const now = new Date().toISOString();
  const renewalDate = renewalDateFor(agreement.effective_from, agreement.billing_interval);

  const row = {
    tenant_id: agreement.tenant_id,
    plan_id: agreement.plan_id,
    programme_id: agreement.programme_id,
    billing_interval: agreement.billing_interval,
    status: "active",
    agreement_id: agreement.id,
    activated_at: now,
    renewal_date: renewalDate,
    renewal_status: "not_due",
    cancel_requested_at: null,
    cancel_requested_by: null,
    cancellation_reason: null,
    cancelled_at: null,
    suspended_at: null,
    past_due_since: null,
  };
  const q = existing
    ? sb.from("restaurant_subscriptions").update(row).eq("tenant_id", agreement.tenant_id)
    : sb.from("restaurant_subscriptions").insert({ ...row, plan: "managed", seats: 5 });
  const { data: subscription, error } = await q.select("*").single();
  if (error) throw new Error(error.message);

  await sb
    .from("commercial_agreements")
    .update({ status: "active", subscription_id: subscription.id })
    .eq("id", agreement.id);

  await setCommercialStatus(sb, userId, agreement.tenant_id, "active");

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "subscription.activate",
    entityType: "restaurant_subscriptions",
    entityId: subscription.id,
    tenantId: agreement.tenant_id,
    before: existing,
    after: subscription,
    reason: input.reason ?? null,
    reference: agreement.contract_reference,
  });
  await sendCommercialNotification(sb, {
    tenantId: agreement.tenant_id,
    eventType: "activation_confirmation",
    entityType: "restaurant_subscriptions",
    entityId: subscription.id,
    idempotencyKey: `subscription-activated-${subscription.id}-${agreement.id}`,
    subject: "Your LexiBite subscription is active",
    body: `Your subscription (${agreement.contract_reference}) is now active. Next renewal: ${renewalDate}.`,
  });
  return subscription;
}

export async function cancelSubscription(sb: Sb, userId: string, input: CancelSubscriptionInput) {
  await assertCommercialAdmin(sb, userId);
  const existing = await loadSubscription(sb, input.tenantId);
  if (!existing) throw new Error("No subscription found for this tenant.");
  if (existing.status === "cancelled") return existing;

  const { data, error } = await sb
    .from("restaurant_subscriptions")
    .update({
      status: "cancelled",
      cancel_requested_at: new Date().toISOString(),
      cancel_requested_by: userId,
      cancellation_reason: input.reason,
      cancelled_at: new Date().toISOString(),
    })
    .eq("tenant_id", input.tenantId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await setCommercialStatus(sb, userId, input.tenantId, "cancelled");
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "subscription.cancel",
    entityType: "restaurant_subscriptions",
    entityId: data.id,
    tenantId: input.tenantId,
    before: existing,
    after: data,
    reason: input.reason,
  });
  await sendCommercialNotification(sb, {
    tenantId: input.tenantId,
    eventType: "subscription_cancelled",
    entityType: "restaurant_subscriptions",
    entityId: data.id,
    idempotencyKey: `subscription-cancelled-${data.id}-${Date.now()}`,
    subject: "Your LexiBite subscription has been cancelled",
    body: `Your subscription has been cancelled. Reason on file: ${input.reason}`,
  });
  return data;
}

export async function suspendSubscription(sb: Sb, userId: string, input: SuspendSubscriptionInput) {
  await assertCommercialAdmin(sb, userId);
  const existing = await loadSubscription(sb, input.tenantId);
  if (!existing) throw new Error("No subscription found for this tenant.");
  if (["cancelled", "suspended"].includes(existing.status)) return existing;

  const { data, error } = await sb
    .from("restaurant_subscriptions")
    .update({ status: "suspended", suspended_at: new Date().toISOString() })
    .eq("tenant_id", input.tenantId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await setCommercialStatus(sb, userId, input.tenantId, "suspended");
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "subscription.suspend",
    entityType: "restaurant_subscriptions",
    entityId: data.id,
    tenantId: input.tenantId,
    before: existing,
    after: data,
    reason: input.reason,
  });
  await sendCommercialNotification(sb, {
    tenantId: input.tenantId,
    eventType: "subscription_suspended",
    entityType: "restaurant_subscriptions",
    entityId: data.id,
    idempotencyKey: `subscription-suspended-${data.id}-${Date.now()}`,
    subject: "Your LexiBite subscription has been suspended",
    body: `Your subscription has been suspended. Reason on file: ${input.reason}`,
  });
  return data;
}

export async function reactivateSubscription(
  sb: Sb,
  userId: string,
  input: ReactivateSubscriptionInput,
) {
  await assertCommercialAdmin(sb, userId);
  const existing = await loadSubscription(sb, input.tenantId);
  if (!existing) throw new Error("No subscription found for this tenant.");
  if (existing.status === "cancelled") {
    throw new Error(
      "A cancelled subscription cannot be reactivated — create a new agreement and activate it.",
    );
  }
  if (existing.status === "active") return existing;

  const { data, error } = await sb
    .from("restaurant_subscriptions")
    .update({ status: "active", suspended_at: null, past_due_since: null })
    .eq("tenant_id", input.tenantId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await setCommercialStatus(sb, userId, input.tenantId, "active");
  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "subscription.reactivate",
    entityType: "restaurant_subscriptions",
    entityId: data.id,
    tenantId: input.tenantId,
    before: existing,
    after: data,
    reason: input.reason,
  });
  return data;
}

/**
 * §24 — creates a NEW agreement (never mutates the current one) snapshotting
 * TODAY's catalogue pricing, approves it, marks the prior agreement
 * superseded, and rolls the subscription onto it. A renewal only ever
 * happens through this explicit action — global pricing changing on its
 * own never alters a live subscription's charge.
 */
export async function renewSubscription(sb: Sb, userId: string, input: RenewSubscriptionInput) {
  await assertCommercialAdmin(sb, userId);
  const subscription = await loadSubscription(sb, input.tenantId);
  if (!subscription) throw new Error("No subscription found for this tenant.");
  if (!subscription.agreement_id)
    throw new Error("Subscription has no current agreement to renew from.");

  const current = await getAgreement(sb, subscription.agreement_id);
  if (!current) throw new Error("Current agreement not found.");

  const renewed = await createAgreement(sb, userId, {
    tenantId: input.tenantId,
    planId: current.plan_id,
    programmeId: current.programme_id ?? undefined,
    billingInterval: current.billing_interval,
    discountPct: input.keepDiscount ? (current.discount_pct ?? undefined) : undefined,
    discountReason: input.keepDiscount ? (current.discount_reason ?? undefined) : undefined,
    requiresPaymentBeforeActivation: current.requires_payment_before_activation,
    renewedFromAgreementId: current.id,
  });
  await approveAgreement(sb, userId, {
    agreementId: renewed.id,
    reason: input.reason ?? "Renewal",
  });
  // A renewal of an already-active subscription takes over immediately as
  // the live agreement — it does not re-run the fresh-activation payment
  // gate (assertCanActivate), since the subscription it backs is already
  // commercially active. "approved" is a pre-activation state; this
  // agreement is never pre-activation.
  await sb.from("commercial_agreements").update({ status: "active" }).eq("id", renewed.id);
  renewed.status = "active";

  await sb.from("commercial_agreements").update({ status: "superseded" }).eq("id", current.id);

  const renewalDate = renewalDateFor(renewed.effective_from, renewed.billing_interval);
  const { data, error } = await sb
    .from("restaurant_subscriptions")
    .update({
      agreement_id: renewed.id,
      plan_id: renewed.plan_id,
      programme_id: renewed.programme_id,
      billing_interval: renewed.billing_interval,
      renewal_status: "renewed",
      renewal_date: renewalDate,
      status: subscription.status === "expired" ? "active" : subscription.status,
    })
    .eq("tenant_id", input.tenantId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await writeCommercialAudit(sb, {
    actorId: userId,
    action: "subscription.renew",
    entityType: "restaurant_subscriptions",
    entityId: data.id,
    tenantId: input.tenantId,
    before: subscription,
    after: data,
    reason: input.reason ?? null,
    reference: renewed.contract_reference,
  });
  await sendCommercialNotification(sb, {
    tenantId: input.tenantId,
    eventType: "subscription_renewed",
    entityType: "restaurant_subscriptions",
    entityId: data.id,
    idempotencyKey: `subscription-renewed-${renewed.id}`,
    subject: "Your LexiBite subscription has been renewed",
    body: `Your subscription has been renewed under agreement ${renewed.contract_reference}. Next renewal: ${renewalDate}.`,
  });
  return { subscription: data, agreement: renewed };
}
