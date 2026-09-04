/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Mobile Money Payment Core.
 *
 * The only module that knows a MobileMoneyAdapter exists. POS code never
 * imports an adapter or an env var directly — it requests a collection and
 * reads back a MobileMoneyStatusView. Mirrors the existing
 * selfpay.server.ts/pesapal.server.ts and fiscal.server.ts boundaries.
 *
 * A collection attempt is never a payment. It becomes one — a real
 * restaurant_payments row, through the exact insert/idempotency shape
 * takePosPayment already uses (client_request_id, recalcOrder, auto-close)
 * — only once genuinely confirmed PAID, and only after the confirmed
 * amount/currency is reconciled against what was actually requested
 * (mirrors confirmGuestPayment's "re-verify, don't trust" pattern for
 * Pesapal). A successful create/accept response means a payment was
 * requested, never that money was received.
 */
import { assertCapability, assertTenantRead } from "../../core/access.server";
import { emitRestaurantEvent } from "../../events/emit.server";
import type { MobileMoneyAdapter } from "./adapter";
import { createLipaNambaAdapter } from "./providers/lipaNambaAdapter.server";
import { createTestMobileMoneyAdapter } from "./providers/testAdapter.server";
import { createAggregatorAdapter } from "./providers/aggregatorAdapter.server";
import {
  operatorMessageForCollectionState,
  reconciliationStateForCollection,
  upsertMobileMoneyAccountSchema,
  type MobileMoneyCollectionState,
  type MobileMoneyEnvironment,
  type MobileMoneyHealthStatus,
  type MobileMoneyMode,
  type MobileMoneyStatusView,
  type UpsertMobileMoneyAccountInput,
} from "./contracts";

type Sb = any;

/** A cent of slack against floating-point/rounding noise — same tolerance confirmGuestPayment already uses. */
const AMOUNT_TOLERANCE = 0.01;

export function getConfiguredMobileMoneyAdapter(
  mode: MobileMoneyMode,
  environment: MobileMoneyEnvironment,
): MobileMoneyAdapter | null {
  if (mode === "lipa_namba") return createLipaNambaAdapter();
  if (environment === "test") return createTestMobileMoneyAdapter("success");
  return createAggregatorAdapter();
}

function toStatusView(row: any): MobileMoneyStatusView {
  const state: MobileMoneyCollectionState = row.state;
  return {
    collectionId: row.id,
    state,
    operatorMessage: operatorMessageForCollectionState(state, row.mode),
    amount: Number(row.amount),
    currency: row.currency,
    mode: row.mode,
    network: row.network,
    merchantNumber: row.merchant_number_snapshot ?? null,
    customerPhone: row.customer_phone ?? null,
    requiresManualConfirmation: state === "manual_confirmation_required",
  };
}

// ---------------------------------------------------------------------------
// Account configuration
// ---------------------------------------------------------------------------

/**
 * Ordinary tenant read, not the narrower mobile_money.view: every
 * sales.manage-capable role (including bartender/chef/kitchen_manager)
 * needs to know whether Mobile Money is active before taking a payment at
 * POS, and the merchant number is shown to the customer anyway — it is
 * not a secret, unlike fiscal's TIN/VRN. Config *writes* stay narrow
 * (mobile_money.manage) via upsertMobileMoneyAccount below.
 */
export async function getMobileMoneyAccount(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId: string },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data } = await sb
    .from("restaurant_mobile_money_accounts")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  return data ?? null;
}

export async function upsertMobileMoneyAccount(
  sb: Sb,
  userId: string,
  raw: UpsertMobileMoneyAccountInput,
) {
  const input = upsertMobileMoneyAccountSchema.parse(raw);
  await assertCapability(sb, userId, input.tenantId, "mobile_money.manage");

  const { data: account, error } = await sb
    .from("restaurant_mobile_money_accounts")
    .upsert(
      {
        tenant_id: input.tenantId,
        property_id: input.propertyId ?? null,
        location_id: input.locationId,
        mode: input.mode,
        network: input.network,
        merchant_number: input.merchantNumber,
        environment: input.environment,
        activation_state: input.activationState,
        created_by: userId,
      },
      { onConflict: "tenant_id,location_id" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.payment.mobile_money.configuration.updated",
    tenantId: input.tenantId,
    propertyId: input.propertyId ?? undefined,
    locationId: input.locationId,
    entityType: "restaurant_mobile_money_account",
    entityId: account.id,
    source: "restaurant-payments",
    payload: { mode: input.mode, network: input.network, activation_state: input.activationState },
  });

  return account;
}

// ---------------------------------------------------------------------------
// Collection request
// ---------------------------------------------------------------------------

export async function requestMobileMoneyCollection(
  sb: Sb,
  userId: string,
  input: {
    tenantId: string;
    orderId: string;
    amount: number;
    customerPhone?: string | null;
    clientRequestId: string;
  },
  adapterOverride?: MobileMoneyAdapter | null,
): Promise<MobileMoneyStatusView> {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");

  const { data: order } = await sb
    .from("restaurant_orders")
    .select("id, tenant_id, property_id, location_id, currency")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .single();
  if (!order) throw new Error("Order not found.");

  const { data: existing } = await sb
    .from("restaurant_mobile_money_collections")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("idempotency_key", input.clientRequestId)
    .maybeSingle();
  if (existing) return toStatusView(existing);

  const { data: account } = await sb
    .from("restaurant_mobile_money_accounts")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("location_id", order.location_id)
    .maybeSingle();
  if (!account || account.activation_state !== "active") {
    throw new Error(
      "Mobile Money is not activated for this outlet. Turn it on in Settings → Payments → Mobile Money.",
    );
  }

  const { data: created, error: insertError } = await sb
    .from("restaurant_mobile_money_collections")
    .insert({
      tenant_id: input.tenantId,
      property_id: order.property_id ?? null,
      location_id: order.location_id,
      order_id: order.id,
      account_id: account.id,
      mode: account.mode,
      network: account.network,
      merchant_number_snapshot: account.merchant_number,
      customer_phone: input.customerPhone ?? null,
      amount: input.amount,
      currency: order.currency ?? "TZS",
      environment: account.environment,
      idempotency_key: input.clientRequestId,
      created_by: userId,
    })
    .select("*")
    .single();

  let collection = created;
  if (insertError) {
    if ((insertError as any).code !== "23505") throw new Error(insertError.message);
    const { data: raced } = await sb
      .from("restaurant_mobile_money_collections")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("idempotency_key", input.clientRequestId)
      .single();
    if (!raced) throw new Error(insertError.message);
    return toStatusView(raced);
  }

  const adapter =
    adapterOverride !== undefined
      ? adapterOverride
      : getConfiguredMobileMoneyAdapter(account.mode, account.environment);
  if (!adapter) {
    collection = await patchCollection(sb, collection.id, input.tenantId, {
      state: "failed",
      last_error_class: "configuration",
      last_error_message: "No mobile money provider is configured for this environment.",
    });
    return toStatusView(collection);
  }

  const result = await adapter.createCollection({
    environment: account.environment,
    idempotencyKey: input.clientRequestId,
    network: account.network,
    merchantNumber: account.merchant_number,
    customerPhone: input.customerPhone ?? null,
    amount: input.amount,
    currency: order.currency ?? "TZS",
    reference: `mm:${collection.id}`,
  });

  if (result.outcome === "rejected") {
    collection = await patchCollection(sb, collection.id, input.tenantId, {
      state: "failed",
      attempt_count: 1,
      provider_code: adapter.providerCode,
      last_error_class: result.errorClass,
      last_error_message: result.reason,
    });
    await emitCollectionEvent(
      sb,
      userId,
      "restaurant.payment.mobile_money.request.failed",
      order,
      collection,
    );
    return toStatusView(collection);
  }

  const nextState: MobileMoneyCollectionState = adapter.automatic
    ? "pending_customer"
    : "manual_confirmation_required";
  collection = await patchCollection(sb, collection.id, input.tenantId, {
    state: nextState,
    attempt_count: 1,
    provider_code: adapter.providerCode,
    provider_reference: result.providerReference,
  });
  await emitCollectionEvent(
    sb,
    userId,
    "restaurant.payment.mobile_money.requested",
    order,
    collection,
  );
  return toStatusView(collection);
}

/**
 * Confirms a collection as PAID and — only now — records it as a real
 * payment. `actorUserId` present means a staff member is manually
 * confirming (Lipa Namba's "Mark as received"); absent means the webhook
 * receiver is confirming on the provider's behalf (no staff session
 * exists for a server-to-server callback, exactly like recordGuestPayment).
 * Idempotent: a collection already PAID is returned unchanged.
 */
export async function confirmMobileMoneyCollection(
  sb: Sb,
  input: {
    tenantId: string;
    collectionId: string;
    providerReference?: string;
    confirmedAmount?: number;
    confirmedCurrency?: string;
    actorUserId?: string;
  },
): Promise<MobileMoneyStatusView> {
  const { data: collection } = await sb
    .from("restaurant_mobile_money_collections")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.collectionId)
    .single();
  if (!collection) throw new Error("Collection not found.");
  if (collection.state === "paid") return toStatusView(collection);
  if (["cancelled", "reversed", "refunded"].includes(collection.state))
    return toStatusView(collection);

  if (input.actorUserId) {
    await assertCapability(sb, input.actorUserId, input.tenantId, "sales.manage");
  }

  const amount = input.confirmedAmount ?? Number(collection.amount);
  const currency = input.confirmedCurrency ?? collection.currency;
  if (
    Math.abs(amount - Number(collection.amount)) > AMOUNT_TOLERANCE ||
    currency !== collection.currency
  ) {
    const failed = await patchCollection(sb, collection.id, input.tenantId, {
      state: "failed",
      last_error_class: "wrong_amount",
      last_error_message: `Provider confirmed ${amount} ${currency}, expected ${collection.amount} ${collection.currency}.`,
    });
    return toStatusView(failed);
  }

  const clientRequestId = `mm:${collection.id}`;
  const { data: duplicate } = await sb
    .from("restaurant_payments")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();

  let paymentId = duplicate?.id ?? null;
  if (!duplicate) {
    const { data: payment, error } = await sb
      .from("restaurant_payments")
      .insert({
        tenant_id: input.tenantId,
        order_id: collection.order_id,
        client_request_id: clientRequestId,
        method: "mobile_money",
        state: "paid",
        amount,
        currency,
        reference: input.providerReference ?? collection.provider_reference ?? null,
        created_by: input.actorUserId ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    paymentId = payment.id;
  }

  const { recalcOrder, transitionOrder } = await import("../../sales/sales.server");
  let totals = await recalcOrder(sb, input.tenantId, collection.order_id);
  const settled = ["paid", "comped", "room_charged"].includes(String(totals.payment_state));
  if (settled && totals.status !== "closed") {
    try {
      // Auto-close needs a real principal for assertCapability. A
      // webhook-confirmed payment with no staff session simply leaves the
      // order settled-but-open for a staff member to close at the till —
      // the payment itself is still recorded correctly either way.
      await transitionOrder(sb, input.actorUserId ?? SYSTEM_USER_SENTINEL, {
        tenantId: input.tenantId,
        orderId: collection.order_id,
        status: "closed",
      });
      // Closing is also the trigger point for the receipt — and, per the
      // TRA Fiscal Core, fiscalization is requested only once a receipt is
      // issued for a genuinely confirmed payment (never on mere
      // initiation). Mirrors takePosPayment's own closeWhenSettled path.
      const { getReceipt } = await import("../../sales/receipts.server");
      await getReceipt(sb, input.actorUserId ?? SYSTEM_USER_SENTINEL, {
        tenantId: input.tenantId,
        orderId: collection.order_id,
      });
    } catch {
      // See comment above — leaves the order settled-but-open, not an error.
    }
    totals = await recalcOrder(sb, input.tenantId, collection.order_id);
  }

  const confirmed = await patchCollection(sb, collection.id, input.tenantId, {
    state: "paid",
    restaurant_payment_id: paymentId,
    confirmed_at: new Date().toISOString(),
    provider_reference: input.providerReference ?? collection.provider_reference,
  });

  await emitRestaurantEvent(sb, input.actorUserId ?? "system", {
    type: "restaurant.payment.mobile_money.confirmed",
    tenantId: input.tenantId,
    propertyId: collection.property_id ?? undefined,
    locationId: collection.location_id ?? undefined,
    entityType: "restaurant_mobile_money_collection",
    entityId: collection.id,
    source: "restaurant-payments",
    payload: { order_id: collection.order_id, amount, currency },
    dedupeKey: `mm-confirmed:${collection.id}`,
  }).catch(() => undefined);

  return toStatusView(confirmed);
}

/** A staff member's own capability check stands in for a principal on the auto-close path when no real user drove confirmation. */
const SYSTEM_USER_SENTINEL = "00000000-0000-0000-0000-000000000000";

export async function failMobileMoneyCollection(
  sb: Sb,
  input: { tenantId: string; collectionId: string; errorClass: string; message: string },
): Promise<MobileMoneyStatusView> {
  const { data: collection } = await sb
    .from("restaurant_mobile_money_collections")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.collectionId)
    .single();
  if (!collection) throw new Error("Collection not found.");
  if (["paid", "cancelled", "reversed", "refunded"].includes(collection.state))
    return toStatusView(collection);

  const failed = await patchCollection(sb, collection.id, input.tenantId, {
    state: "failed",
    last_error_class: input.errorClass,
    last_error_message: input.message,
  });
  return toStatusView(failed);
}

export async function cancelMobileMoneyCollection(
  sb: Sb,
  userId: string,
  input: { tenantId: string; collectionId: string; reason?: string },
): Promise<MobileMoneyStatusView> {
  await assertCapability(sb, userId, input.tenantId, "sales.manage");
  const { data: collection } = await sb
    .from("restaurant_mobile_money_collections")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.collectionId)
    .single();
  if (!collection) throw new Error("Collection not found.");
  if (collection.state === "paid")
    throw new Error("This payment has already been received — it cannot be cancelled.");

  const cancelled = await patchCollection(sb, collection.id, input.tenantId, {
    state: "cancelled",
    last_error_message: input.reason ?? null,
  });
  return toStatusView(cancelled);
}

/**
 * Re-polls the provider for a live collection. Never trusts what it hears
 * without also reconciling the amount, exactly like confirmMobileMoneyCollection.
 */
export async function refreshMobileMoneyCollectionStatus(
  sb: Sb,
  input: { tenantId: string; collectionId: string },
  adapterOverride?: MobileMoneyAdapter | null,
): Promise<MobileMoneyStatusView> {
  const { data: collection } = await sb
    .from("restaurant_mobile_money_collections")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.collectionId)
    .single();
  if (!collection) throw new Error("Collection not found.");
  if (
    [
      "paid",
      "cancelled",
      "reversed",
      "refunded",
      "failed",
      "manual_confirmation_required",
    ].includes(collection.state)
  ) {
    return toStatusView(collection);
  }
  if (!collection.provider_reference) return toStatusView(collection);

  const adapter =
    adapterOverride !== undefined
      ? adapterOverride
      : getConfiguredMobileMoneyAdapter(collection.mode, collection.environment);
  if (!adapter) return toStatusView(collection);

  const status = await adapter.verifyTransaction(collection.provider_reference);
  if (status.outcome === "paid") {
    return confirmMobileMoneyCollection(sb, {
      tenantId: input.tenantId,
      collectionId: collection.id,
      providerReference: status.providerReference,
      confirmedAmount: status.confirmedAmount,
      confirmedCurrency: status.confirmedCurrency,
    });
  }
  if (status.outcome === "failed") {
    return failMobileMoneyCollection(sb, {
      tenantId: input.tenantId,
      collectionId: collection.id,
      errorClass: status.errorClass,
      message: status.reason,
    });
  }
  return toStatusView(collection);
}

// ---------------------------------------------------------------------------
// Reversal / refund — a compensating event, never a silent delete.
// ---------------------------------------------------------------------------

export async function reverseMobileMoneyCollection(
  sb: Sb,
  userId: string,
  input: { tenantId: string; collectionId: string; amount?: number; reason: string },
) {
  await assertCapability(sb, userId, input.tenantId, "mobile_money.manage");
  const { data: collection } = await sb
    .from("restaurant_mobile_money_collections")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.collectionId)
    .single();
  if (!collection) throw new Error("Collection not found.");
  if (collection.state !== "paid") throw new Error("Only a paid collection can be reversed.");

  const amount = input.amount ?? Number(collection.amount);
  const adapter = getConfiguredMobileMoneyAdapter(collection.mode, collection.environment);
  const reversal =
    adapter && collection.provider_reference
      ? await adapter.reversePayment(collection.provider_reference, amount)
      : {
          outcome: "unsupported" as const,
          reason: "No provider available to reverse automatically.",
        };

  // Preserve the original transaction; never delete it. Mark it 'refunded'
  // so recalcOrder (which already excludes refunded rows) correctly drops
  // it from paid_total, and record the compensating event alongside.
  if (collection.restaurant_payment_id) {
    await sb
      .from("restaurant_payments")
      .update({ state: "refunded" })
      .eq("tenant_id", input.tenantId)
      .eq("id", collection.restaurant_payment_id);
  }

  const { data: refund, error } = await sb
    .from("restaurant_mobile_money_refunds")
    .insert({
      tenant_id: input.tenantId,
      collection_id: collection.id,
      restaurant_payment_id: collection.restaurant_payment_id,
      amount,
      reason: input.reason,
      state: reversal.outcome === "reversed" ? "completed" : "completed_manual",
      provider_reference: reversal.outcome === "reversed" ? reversal.providerReference : null,
      requested_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  const reversed = await patchCollection(sb, collection.id, input.tenantId, { state: "reversed" });

  const { recalcOrder } = await import("../../sales/sales.server");
  await recalcOrder(sb, input.tenantId, collection.order_id);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.payment.mobile_money.reversed",
    tenantId: input.tenantId,
    propertyId: collection.property_id ?? undefined,
    locationId: collection.location_id ?? undefined,
    entityType: "restaurant_mobile_money_collection",
    entityId: collection.id,
    source: "restaurant-payments",
    payload: { amount, provider_automatic: reversal.outcome === "reversed" },
  });

  return { collection: toStatusView(reversed), refund };
}

// ---------------------------------------------------------------------------
// Webhook processing — called only from api/mobile-money-webhook.ts with a
// service-role client. Idempotent by (provider_code, provider_event_id).
// ---------------------------------------------------------------------------

export async function handleMobileMoneyWebhookEvent(
  sb: Sb,
  input: { providerCode: string; rawBody: string; headers: Record<string, string> },
) {
  const adapter =
    input.providerCode === "test"
      ? createTestMobileMoneyAdapter("success")
      : createAggregatorAdapter();
  if (!adapter) return { processed: false, reason: "no_provider_configured" as const };

  const parsed = await adapter.handleWebhook({ headers: input.headers, rawBody: input.rawBody });
  if (parsed.outcome === "invalid") {
    await sb.from("restaurant_mobile_money_webhook_events").insert({
      provider_code: input.providerCode,
      provider_event_id: `invalid:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      signature_valid: false,
      outcome: "invalid",
      raw_payload: safeJson(input.rawBody),
    });
    return { processed: false, reason: parsed.reason };
  }

  const { data: inserted, error: dupError } = await sb
    .from("restaurant_mobile_money_webhook_events")
    .insert({
      provider_code: input.providerCode,
      provider_event_id: parsed.providerEventId,
      signature_valid: parsed.signatureValid,
      raw_payload: safeJson(input.rawBody),
    })
    .select("id")
    .single();

  if (dupError) {
    if ((dupError as any).code === "23505") return { processed: true, duplicate: true };
    throw new Error(dupError.message);
  }

  if (!parsed.signatureValid) {
    await sb
      .from("restaurant_mobile_money_webhook_events")
      .update({ outcome: "signature_invalid", processed_at: new Date().toISOString() })
      .eq("id", inserted.id);
    return { processed: false, reason: "signature_invalid" as const };
  }

  const { data: collection } = await sb
    .from("restaurant_mobile_money_collections")
    .select("*")
    .eq("provider_reference", parsed.providerReference)
    .maybeSingle();

  if (!collection) {
    await sb
      .from("restaurant_mobile_money_webhook_events")
      .update({ outcome: "collection_not_found", processed_at: new Date().toISOString() })
      .eq("id", inserted.id);
    return { processed: false, reason: "collection_not_found" as const };
  }

  await sb
    .from("restaurant_mobile_money_webhook_events")
    .update({ tenant_id: collection.tenant_id, collection_id: collection.id })
    .eq("id", inserted.id);

  // Never trust the webhook's own status/amount directly — re-verify with
  // the provider, exactly like confirmGuestPayment does for Pesapal.
  const verified = await adapter.verifyTransaction(parsed.providerReference);
  let outcome = "no_op";
  if (verified.outcome === "paid") {
    await confirmMobileMoneyCollection(sb, {
      tenantId: collection.tenant_id,
      collectionId: collection.id,
      providerReference: verified.providerReference,
      confirmedAmount: verified.confirmedAmount,
      confirmedCurrency: verified.confirmedCurrency,
    });
    outcome = "confirmed";
  } else if (verified.outcome === "failed") {
    await failMobileMoneyCollection(sb, {
      tenantId: collection.tenant_id,
      collectionId: collection.id,
      errorClass: verified.errorClass,
      message: verified.reason,
    });
    outcome = "failed";
  }

  await sb
    .from("restaurant_mobile_money_webhook_events")
    .update({ outcome, processed_at: new Date().toISOString() })
    .eq("id", inserted.id);

  return { processed: true, outcome };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function patchCollection(
  sb: Sb,
  id: string,
  tenantId: string,
  patch: Record<string, unknown>,
) {
  const { data, error } = await sb
    .from("restaurant_mobile_money_collections")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function emitCollectionEvent(sb: Sb, userId: string, type: any, order: any, collection: any) {
  await emitRestaurantEvent(sb, userId, {
    type,
    tenantId: collection.tenant_id,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_mobile_money_collection",
    entityId: collection.id,
    source: "restaurant-payments",
    payload: { order_id: order.id, state: collection.state, amount: Number(collection.amount) },
    dedupeKey: `mm:${collection.id}:${collection.state}:${collection.attempt_count}`,
  });
}

// ---------------------------------------------------------------------------
// Read surfaces
// ---------------------------------------------------------------------------

export async function getMobileMoneyStatus(
  sb: Sb,
  userId: string,
  input: { tenantId: string; collectionId: string },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data } = await sb
    .from("restaurant_mobile_money_collections")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.collectionId)
    .maybeSingle();
  return data ? toStatusView(data) : null;
}

export async function listMobileMoneyCollectionsForOrder(
  sb: Sb,
  userId: string,
  input: { tenantId: string; orderId: string },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data } = await sb
    .from("restaurant_mobile_money_collections")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", input.orderId)
    .order("requested_at", { ascending: false });
  return ((data ?? []) as any[]).map(toStatusView);
}

export async function listMobileMoneyReconciliation(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId?: string; limit?: number },
) {
  await assertCapability(sb, userId, input.tenantId, "mobile_money.view");
  let query = sb
    .from("restaurant_mobile_money_collections")
    .select(
      "id, order_id, location_id, mode, network, amount, currency, state, provider_reference, restaurant_payment_id, requested_at, confirmed_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("requested_at", { ascending: false })
    .limit(input.limit ?? 50);
  if (input.locationId) query = query.eq("location_id", input.locationId);
  const { data } = await query;
  return ((data ?? []) as any[]).map((r) => ({
    ...r,
    reconciliationState: reconciliationStateForCollection(r.state),
  }));
}

export async function getMobileMoneyHealth(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId?: string },
): Promise<{
  status: MobileMoneyHealthStatus;
  paidToday: number;
  pendingToday: number;
  failedToday: number;
}> {
  await assertCapability(sb, userId, input.tenantId, "mobile_money.view");
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  let query = sb
    .from("restaurant_mobile_money_collections")
    .select("state")
    .eq("tenant_id", input.tenantId)
    .gte("requested_at", startOfDay.toISOString());
  if (input.locationId) query = query.eq("location_id", input.locationId);
  const { data } = await query;
  const rows = (data ?? []) as any[];

  const paidToday = rows.filter((r) => r.state === "paid").length;
  const failedToday = rows.filter((r) => ["failed", "expired"].includes(r.state)).length;
  const pendingToday = rows.length - paidToday - failedToday;

  let accountQuery = sb
    .from("restaurant_mobile_money_accounts")
    .select("mode, environment, activation_state")
    .eq("tenant_id", input.tenantId);
  if (input.locationId) accountQuery = accountQuery.eq("location_id", input.locationId);
  const { data: accounts } = await accountQuery;
  const active = ((accounts ?? []) as any[]).find((a) => a.activation_state === "active");

  let status: MobileMoneyHealthStatus = "configuration_required";
  if (active) {
    const adapter = getConfiguredMobileMoneyAdapter(active.mode, active.environment);
    if (!adapter) status = "provider_unavailable";
    else {
      const health = await adapter.healthCheck();
      status = health.ok ? "operational" : "connection_issue";
    }
  }

  return { status, paidToday, pendingToday, failedToday };
}
