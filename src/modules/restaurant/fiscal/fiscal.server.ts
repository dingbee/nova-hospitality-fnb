/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Fiscal Core.
 *
 * The only module that knows a FiscalProviderAdapter exists. POS code never
 * imports an adapter or an env var directly — it calls requestFiscalization
 * and reads back a FiscalStatusView. This mirrors the existing
 * selfpay.server.ts / pesapal.server.ts boundary for guest payments.
 *
 * Fiscalization is best-effort and non-blocking: a fiscal failure must never
 * fail the payment or the receipt that triggered it (spec section 14 — a
 * payment and a fiscalization are separate truths). Callers are expected to
 * wrap requestFiscalization in try/catch exactly as emitRestaurantEvent
 * callers already do for intelligence events.
 */
import {
  accessibleLocationIds,
  assertCapability,
  assertTenantRead,
  getTenantScope,
  NO_MATCH_ID,
} from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import type { FiscalProviderAdapter, FiscalSubmissionInput } from "./adapter";
import { createTestFiscalAdapter } from "./providers/testAdapter.server";
import { createTraEfdAdapter } from "./providers/traEfd.server";
import {
  fiscalIdempotencyKey,
  operatorMessageForState,
  upsertFiscalConfigurationSchema,
  type FiscalEnvironment,
  type FiscalState,
  type FiscalStatusView,
  type UpsertFiscalConfigurationInput,
} from "./contracts";

type Sb = any;

export function getConfiguredFiscalProvider(
  environment: FiscalEnvironment,
): FiscalProviderAdapter | null {
  if (environment === "test") return createTestFiscalAdapter("success");
  return createTraEfdAdapter();
}

function toStatusView(row: any | null): FiscalStatusView {
  const state: FiscalState = row?.state ?? "not_required";
  return {
    state,
    operatorMessage: operatorMessageForState(state),
    fiscalReceiptNumber: row?.fiscal_receipt_number ?? null,
    verificationCode: row?.verification_code ?? null,
    zNumber: row?.z_number ?? null,
    fiscalizedAt: row?.fiscalized_at ?? null,
    environment: row?.environment ?? null,
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export async function getFiscalConfiguration(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "fiscal.view", {
    locationId: input.locationId,
  });
  const { data } = await sb
    .from("restaurant_fiscal_configurations")
    .select("*, restaurant_fiscal_devices(*)")
    .eq("tenant_id", input.tenantId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  return data ?? null;
}

export async function upsertFiscalConfiguration(
  sb: Sb,
  userId: string,
  raw: UpsertFiscalConfigurationInput,
) {
  const input = upsertFiscalConfigurationSchema.parse(raw);
  await assertCapability(sb, userId, input.tenantId, "fiscal.manage", {
    locationId: input.locationId,
  });

  // Authoritative property comes from the location row, never the client's
  // separate propertyId field (same rule as mobile money's account upsert).
  const { data: location } = await sb
    .from("restaurant_locations")
    .select("id, property_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.locationId)
    .maybeSingle();
  if (!location) throw new Error("Location not found for this tenant.");

  const { data: config, error } = await sb
    .from("restaurant_fiscal_configurations")
    .upsert(
      {
        tenant_id: input.tenantId,
        property_id: location.property_id,
        location_id: input.locationId,
        business_name: input.businessName,
        tin: input.tin ?? null,
        vrn: input.vrn ?? null,
        environment: input.environment,
        activation_state: input.activationState,
        created_by: userId,
      },
      { onConflict: "tenant_id,location_id" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  if (input.deviceSerial) {
    await sb.from("restaurant_fiscal_devices").upsert(
      {
        tenant_id: input.tenantId,
        fiscal_configuration_id: config.id,
        device_serial: input.deviceSerial,
        uin: input.deviceUin ?? null,
      },
      { onConflict: "tenant_id,device_serial" },
    );
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.fiscal.configuration.updated",
    tenantId: input.tenantId,
    propertyId: location.property_id ?? undefined,
    locationId: input.locationId,
    entityType: "restaurant_fiscal_configuration",
    entityId: config.id,
    source: "restaurant-fiscal",
    payload: { environment: input.environment, activation_state: input.activationState },
  });

  return config;
}

// ---------------------------------------------------------------------------
// Fiscalization
// ---------------------------------------------------------------------------

/**
 * Idempotent: safe to call once per order, or a hundred times for the same
 * order. A terminal fiscal record (fiscalized / rejected / not_required) is
 * simply returned; a retryable one is retried through the same row.
 */
export async function requestFiscalization(
  sb: Sb,
  userId: string,
  input: { tenantId: string; orderId: string; restaurantReceiptId?: string | null },
  providerOverride?: FiscalProviderAdapter | null,
): Promise<FiscalStatusView> {
  const { data: order } = await sb
    .from("restaurant_orders")
    .select(
      "id, tenant_id, property_id, location_id, currency, subtotal, tax_total, total, closed_at",
    )
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .single();
  if (!order) throw new Error("Order not found.");

  const { data: config } = await sb
    .from("restaurant_fiscal_configurations")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("location_id", order.location_id)
    .maybeSingle();

  // No fiscal configuration for this outlet, or it is explicitly inactive —
  // fiscalization is optional per tenant. Never block the sale on it.
  if (!config || config.activation_state === "inactive") {
    return {
      state: "not_required",
      operatorMessage: operatorMessageForState("not_required"),
      fiscalReceiptNumber: null,
      verificationCode: null,
      zNumber: null,
      fiscalizedAt: null,
      environment: null,
    };
  }

  const idempotencyKey = fiscalIdempotencyKey(order.id);

  let fiscalReceipt = await findOrCreateFiscalReceipt(sb, {
    tenantId: input.tenantId,
    propertyId: order.property_id ?? null,
    locationId: order.location_id,
    orderId: order.id,
    restaurantReceiptId: input.restaurantReceiptId ?? null,
    fiscalConfigurationId: config.id,
    idempotencyKey,
    environment: config.environment,
    currency: order.currency ?? "TZS",
    subtotal: Number(order.subtotal ?? 0),
    taxTotal: Number(order.tax_total ?? 0),
    total: Number(order.total ?? 0),
    tin: config.tin ?? null,
    vrn: config.vrn ?? null,
  });

  // Terminal — nothing to do. This is the duplicate-submission guard: a
  // second call for the same order returns the already-fiscalized record
  // instead of creating a second one.
  if (fiscalReceipt.state === "fiscalized" || fiscalReceipt.state === "rejected") {
    return toStatusView(fiscalReceipt);
  }

  const provider =
    providerOverride !== undefined
      ? providerOverride
      : getConfiguredFiscalProvider(config.environment);
  if (!provider) {
    fiscalReceipt = await markState(
      sb,
      fiscalReceipt,
      "configuration_error",
      "configuration",
      "No fiscal provider is configured for this environment.",
    );
    await emitFiscalEvent(sb, userId, "restaurant.fiscal.submission.failed", order, fiscalReceipt);
    return toStatusView(fiscalReceipt);
  }

  const { data: device } = await sb
    .from("restaurant_fiscal_devices")
    .select("device_serial")
    .eq("tenant_id", input.tenantId)
    .eq("fiscal_configuration_id", config.id)
    .maybeSingle();

  const { data: orderItems } = await sb
    .from("restaurant_order_items")
    .select("id, description, quantity, unit_price, tax_rate, tax_amount, line_total, status")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", order.id);

  const { data: payments } = await sb
    .from("restaurant_payments")
    .select("method")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", order.id);

  const lines = ((orderItems ?? []) as any[])
    .filter((i) => i.status !== "voided")
    .map((i) => ({
      orderItemId: i.id,
      description: String(i.description ?? ""),
      quantity: Number(i.quantity ?? 0),
      unitPrice: Number(i.unit_price ?? 0),
      taxClassificationCode: null,
      taxRate: Number(i.tax_rate ?? 0),
      taxAmount: Number(i.tax_amount ?? 0),
      lineTotal: Number(i.line_total ?? 0),
    }));

  await sb
    .from("restaurant_fiscal_receipt_items")
    .delete()
    .eq("tenant_id", input.tenantId)
    .eq("fiscal_receipt_id", fiscalReceipt.id);
  if (lines.length > 0) {
    await sb.from("restaurant_fiscal_receipt_items").insert(
      lines.map((l) => ({
        tenant_id: input.tenantId,
        fiscal_receipt_id: fiscalReceipt.id,
        order_item_id: l.orderItemId,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        tax_classification_code: l.taxClassificationCode,
        tax_rate: l.taxRate,
        tax_amount: l.taxAmount,
        line_total: l.lineTotal,
      })),
    );
  }

  const attemptNumber = Number(fiscalReceipt.attempt_count ?? 0) + 1;
  await sb.from("restaurant_fiscal_submissions").insert({
    tenant_id: input.tenantId,
    fiscal_receipt_id: fiscalReceipt.id,
    attempt_number: attemptNumber,
    environment: config.environment,
    provider_code: provider.providerCode,
    requested_by: userId,
  });

  fiscalReceipt = await patchFiscalReceipt(sb, fiscalReceipt.id, input.tenantId, {
    state: "submitting",
    attempt_count: attemptNumber,
    provider_code: provider.providerCode,
    device_serial_snapshot: device?.device_serial ?? null,
  });

  const submissionInput: FiscalSubmissionInput = {
    environment: config.environment,
    idempotencyKey,
    configuration: {
      businessName: config.business_name,
      tin: config.tin ?? null,
      vrn: config.vrn ?? null,
      deviceSerial: device?.device_serial ?? null,
    },
    receipt: {
      currency: order.currency ?? "TZS",
      subtotal: Number(order.subtotal ?? 0),
      taxTotal: Number(order.tax_total ?? 0),
      total: Number(order.total ?? 0),
      issuedAt: new Date().toISOString(),
      paymentMethods: ((payments ?? []) as any[]).map((p) => String(p.method)),
      items: lines,
    },
  };

  let result;
  try {
    result = await provider.submitReceipt(submissionInput);
  } catch (err) {
    result = {
      outcome: "network_error" as const,
      errorClass: "network" as const,
      reason: (err as Error).message,
    };
  }

  await sb
    .from("restaurant_fiscal_submissions")
    .update({
      completed_at: new Date().toISOString(),
      outcome: result.outcome,
      error_class: "errorClass" in result ? result.errorClass : null,
      error_detail: "reason" in result ? result.reason : null,
    })
    .eq("tenant_id", input.tenantId)
    .eq("fiscal_receipt_id", fiscalReceipt.id)
    .eq("attempt_number", attemptNumber);

  if (result.outcome === "success") {
    const { data: fiscalNumber, error: numberError } = await sb.rpc(
      "restaurant_next_document_number",
      {
        _tenant: input.tenantId,
        _doc_type: "fiscal_receipt",
        _prefix: "FSC",
      },
    );
    const receiptNumber = numberError || !fiscalNumber ? result.fiscalReceiptNumber : fiscalNumber;

    await sb.from("restaurant_fiscal_acknowledgements").upsert(
      {
        tenant_id: input.tenantId,
        fiscal_receipt_id: fiscalReceipt.id,
        fiscal_receipt_number: receiptNumber,
        verification_code: result.verificationCode,
        z_number: result.zNumber,
        provider_code: provider.providerCode,
        environment: config.environment,
      },
      { onConflict: "tenant_id,fiscal_receipt_id" },
    );

    fiscalReceipt = await patchFiscalReceipt(sb, fiscalReceipt.id, input.tenantId, {
      state: "fiscalized",
      fiscal_receipt_number: receiptNumber,
      verification_code: result.verificationCode,
      z_number: result.zNumber,
      fiscalized_at: new Date().toISOString(),
      last_error_class: null,
      last_error_message: null,
    });
    await emitFiscalEvent(sb, userId, "restaurant.fiscal.receipt.fiscalized", order, fiscalReceipt);
    return toStatusView(fiscalReceipt);
  }

  if (result.outcome === "duplicate") {
    if (result.existingFiscalReceiptNumber) {
      fiscalReceipt = await patchFiscalReceipt(sb, fiscalReceipt.id, input.tenantId, {
        state: "fiscalized",
        fiscal_receipt_number: result.existingFiscalReceiptNumber,
        fiscalized_at: new Date().toISOString(),
      });
      return toStatusView(fiscalReceipt);
    }
    fiscalReceipt = await markState(
      sb,
      fiscalReceipt,
      "retry_required",
      "duplicate",
      "Provider reported a duplicate submission with no receipt reference to recover.",
    );
    return toStatusView(fiscalReceipt);
  }

  if (result.outcome === "rejected") {
    fiscalReceipt = await markState(
      sb,
      fiscalReceipt,
      "rejected",
      result.errorClass,
      result.reason,
    );
    await emitFiscalEvent(sb, userId, "restaurant.fiscal.receipt.rejected", order, fiscalReceipt);
    return toStatusView(fiscalReceipt);
  }

  const stateForOutcome: FiscalState =
    result.outcome === "authentication_error"
      ? "authentication_error"
      : result.outcome === "network_error"
        ? "network_error"
        : "retry_required";
  fiscalReceipt = await markState(
    sb,
    fiscalReceipt,
    stateForOutcome,
    result.errorClass,
    result.reason,
  );
  await emitFiscalEvent(sb, userId, "restaurant.fiscal.submission.failed", order, fiscalReceipt);
  return toStatusView(fiscalReceipt);
}

async function findOrCreateFiscalReceipt(
  sb: Sb,
  args: {
    tenantId: string;
    propertyId: string | null;
    locationId: string;
    orderId: string;
    restaurantReceiptId: string | null;
    fiscalConfigurationId: string;
    idempotencyKey: string;
    environment: FiscalEnvironment;
    currency: string;
    subtotal: number;
    taxTotal: number;
    total: number;
    tin: string | null;
    vrn: string | null;
  },
): Promise<any> {
  const { data: existing } = await sb
    .from("restaurant_fiscal_receipts")
    .select("*")
    .eq("tenant_id", args.tenantId)
    .eq("order_id", args.orderId)
    .maybeSingle();
  if (existing) return existing;

  const { data: inserted, error } = await sb
    .from("restaurant_fiscal_receipts")
    .insert({
      tenant_id: args.tenantId,
      property_id: args.propertyId,
      location_id: args.locationId,
      order_id: args.orderId,
      restaurant_receipt_id: args.restaurantReceiptId,
      fiscal_configuration_id: args.fiscalConfigurationId,
      idempotency_key: args.idempotencyKey,
      state: "pending",
      environment: args.environment,
      currency: args.currency,
      subtotal: args.subtotal,
      tax_total: args.taxTotal,
      total: args.total,
      tin_snapshot: args.tin,
      vrn_snapshot: args.vrn,
    })
    .select("*")
    .single();

  if (!error) return inserted;

  // 23505 = unique_violation. A concurrent caller won the race to create
  // the row for this order — re-read it instead of erroring. This IS the
  // concurrency-safety guarantee (spec sections 12, 38): the database
  // constraint, not application-level locking, decides who created it.
  if ((error as any).code === "23505") {
    const { data: raced } = await sb
      .from("restaurant_fiscal_receipts")
      .select("*")
      .eq("tenant_id", args.tenantId)
      .eq("order_id", args.orderId)
      .single();
    if (raced) return raced;
  }
  throw new Error(error.message);
}

async function patchFiscalReceipt(
  sb: Sb,
  id: string,
  tenantId: string,
  patch: Record<string, unknown>,
) {
  const { data, error } = await sb
    .from("restaurant_fiscal_receipts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function markState(
  sb: Sb,
  fiscalReceipt: any,
  state: FiscalState,
  errorClass: string | null,
  message: string | null,
) {
  return patchFiscalReceipt(sb, fiscalReceipt.id, fiscalReceipt.tenant_id, {
    state,
    last_error_class: errorClass,
    last_error_message: message,
  });
}

async function emitFiscalEvent(sb: Sb, userId: string, type: any, order: any, fiscalReceipt: any) {
  await emitRestaurantEvent(sb, userId, {
    type,
    tenantId: fiscalReceipt.tenant_id,
    propertyId: order.property_id ?? undefined,
    locationId: order.location_id ?? undefined,
    entityType: "restaurant_fiscal_receipt",
    entityId: fiscalReceipt.id,
    source: "restaurant-fiscal",
    payload: {
      order_id: order.id,
      state: fiscalReceipt.state,
      fiscal_receipt_number: fiscalReceipt.fiscal_receipt_number,
      attempt_count: fiscalReceipt.attempt_count,
      error_class: fiscalReceipt.last_error_class,
    },
    dedupeKey: `fiscal:${fiscalReceipt.id}:${fiscalReceipt.state}:${fiscalReceipt.attempt_count}`,
  });
}

// ---------------------------------------------------------------------------
// Read surfaces
// ---------------------------------------------------------------------------

export async function getFiscalStatusForOrder(
  sb: Sb,
  userId: string,
  input: { tenantId: string; orderId: string },
): Promise<FiscalStatusView> {
  const { data: order } = await sb
    .from("restaurant_orders")
    .select("property_id, location_id")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.orderId)
    .maybeSingle();
  await assertTenantRead(sb, userId, input.tenantId, {
    propertyId: order?.property_id ?? null,
    locationId: order?.location_id ?? null,
  });
  const { data } = await sb
    .from("restaurant_fiscal_receipts")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", input.orderId)
    .maybeSingle();
  return toStatusView(data);
}

export async function listFiscalReceipts(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId?: string; limit?: number },
) {
  const scope = await getTenantScope(sb, userId, input.tenantId);
  await assertCapability(sb, userId, input.tenantId, "fiscal.view", {
    locationId: input.locationId ?? null,
  });
  let query = sb
    .from("restaurant_fiscal_receipts")
    .select(
      "id, order_id, location_id, state, environment, fiscal_receipt_number, total, currency, attempt_count, last_error_class, fiscalized_at, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 50);
  if (input.locationId) {
    query = query.eq("location_id", input.locationId);
  } else {
    const ids = await accessibleLocationIds(sb, scope);
    if (ids !== null) query = query.in("location_id", ids.length ? ids : [NO_MATCH_ID]);
  }
  const { data } = await query;
  return data ?? [];
}

export async function getFiscalHealth(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId?: string },
) {
  const scope = await getTenantScope(sb, userId, input.tenantId);
  await assertCapability(sb, userId, input.tenantId, "fiscal.view", {
    locationId: input.locationId ?? null,
  });
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  let query = sb
    .from("restaurant_fiscal_receipts")
    .select("state, fiscalized_at, created_at")
    .eq("tenant_id", input.tenantId)
    .gte("created_at", startOfDay.toISOString());
  if (input.locationId) {
    query = query.eq("location_id", input.locationId);
  } else {
    const ids = await accessibleLocationIds(sb, scope);
    if (ids !== null) query = query.in("location_id", ids.length ? ids : [NO_MATCH_ID]);
  }
  const { data } = await query;
  const rows = (data ?? []) as any[];

  const fiscalized = rows.filter((r) => r.state === "fiscalized");
  const pending = rows.filter((r) => !["fiscalized", "rejected", "not_required"].includes(r.state));
  const rejected = rows.filter((r) => r.state === "rejected");
  const lastFiscalizedAt = fiscalized
    .map((r) => r.fiscalized_at)
    .filter(Boolean)
    .sort()
    .at(-1);

  const provider = getConfiguredFiscalProvider("test");
  const connectivity = provider
    ? await provider.verifyConnectivity()
    : { ok: false, detail: "No fiscal provider configured." };

  return {
    connected: connectivity.ok,
    connectivityDetail: connectivity.detail ?? null,
    fiscalizedToday: fiscalized.length,
    pendingToday: pending.length,
    rejectedToday: rejected.length,
    lastFiscalizedAt: lastFiscalizedAt ?? null,
  };
}

export async function prepareZReportDraft(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId: string; businessDate: string },
) {
  await assertCapability(sb, userId, input.tenantId, "fiscal.manage", {
    locationId: input.locationId,
  });

  const dayStart = new Date(`${input.businessDate}T00:00:00.000Z`);
  const dayEnd = new Date(`${input.businessDate}T23:59:59.999Z`);

  const { data: fiscalized } = await sb
    .from("restaurant_fiscal_receipts")
    .select("subtotal, tax_total, total")
    .eq("tenant_id", input.tenantId)
    .eq("location_id", input.locationId)
    .eq("state", "fiscalized")
    .gte("fiscalized_at", dayStart.toISOString())
    .lte("fiscalized_at", dayEnd.toISOString());

  const rows = (fiscalized ?? []) as any[];
  const subtotal = rows.reduce((s, r) => s + Number(r.subtotal ?? 0), 0);
  const taxTotal = rows.reduce((s, r) => s + Number(r.tax_total ?? 0), 0);
  const total = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);

  const { data: draft, error } = await sb
    .from("restaurant_fiscal_z_reports")
    .upsert(
      {
        tenant_id: input.tenantId,
        location_id: input.locationId,
        business_date: input.businessDate,
        state: "draft",
        receipt_count: rows.length,
        subtotal: Number(subtotal.toFixed(2)),
        tax_total: Number(taxTotal.toFixed(2)),
        total: Number(total.toFixed(2)),
        prepared_by: userId,
      },
      { onConflict: "tenant_id,location_id,business_date" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return draft;
}
