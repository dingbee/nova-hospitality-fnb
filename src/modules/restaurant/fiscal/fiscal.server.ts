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
import {
  createTraEfdAdapter,
  ensureTraAccessToken,
  registerTraVfd,
  submitTraZReport,
} from "./providers/traEfd.server";
import { TraProtocolError, type TraErrorCode } from "./providers/tra/traTypes";
import { formatTraDate, formatTraTime, formatZNum } from "./providers/tra/traXml";
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

/**
 * Both "test" and "production" mean a real TRA integration — "test" is
 * TRA's own TEST/sandbox host (virtual.tra.go.tz), never this repo's
 * internal TestAdapter (providers/testAdapter.server.ts). That adapter is a
 * deterministic double for this repo's own automated tests only; it is
 * never auto-selected here — tests inject it explicitly via
 * requestFiscalization's providerOverride parameter (spec section 26/27:
 * "no mock TRA success" inside the real provider).
 */
export function getConfiguredFiscalProvider(
  environment: FiscalEnvironment,
): FiscalProviderAdapter | null {
  return createTraEfdAdapter(environment);
}

const TRA_ERROR_TO_FISCAL_STATE: Record<TraErrorCode, FiscalState> = {
  TRA_CONFIGURATION_REQUIRED: "configuration_error",
  TRA_CERTIFICATE_MISSING: "configuration_error",
  TRA_CERTIFICATE_INVALID: "configuration_error",
  TRA_CERTIFICATE_PASSWORD_INVALID: "configuration_error",
  TRA_REGISTRATION_FAILED: "configuration_error",
  TRA_AUTHENTICATION_FAILED: "authentication_error",
  TRA_TOKEN_EXPIRED: "authentication_error",
  TRA_NETWORK_ERROR: "network_error",
  TRA_TIMEOUT: "retry_required",
  TRA_REJECTED: "rejected",
  TRA_DUPLICATE: "retry_required",
  TRA_INVALID_XML: "retry_required",
  TRA_SIGNATURE_FAILED: "retry_required",
  TRA_SEQUENCE_ERROR: "retry_required",
  TRA_Z_REPORT_FAILED: "retry_required",
};

/**
 * Allocates GC/DC/ZNUM exactly once per fiscal receipt, via the
 * concurrency-safe restaurant_fiscal_next_counter() RPC, and persists them
 * immediately — before any HTTP call is attempted — so a crash between
 * allocation and submission can never lose or re-issue the numbers. A
 * receipt that already has a gc_number (a prior attempt) always reuses it.
 */
async function allocateOrReuseFiscalNumbering(
  sb: Sb,
  fiscalReceipt: any,
): Promise<{
  gc: number;
  dc: number;
  znum: string;
  rctDate: string;
  rctTime: string;
  rctvnum?: string;
} | null> {
  if (fiscalReceipt.gc_number != null) {
    return {
      gc: Number(fiscalReceipt.gc_number),
      dc: Number(fiscalReceipt.dc_number),
      znum: fiscalReceipt.znum,
      rctDate: fiscalReceipt.rct_date,
      rctTime: fiscalReceipt.rct_time,
      rctvnum: fiscalReceipt.rctvnum ?? undefined,
    };
  }
  const now = new Date();
  const znum = formatZNum(now);
  const gcRes = await sb.rpc("restaurant_fiscal_next_counter", {
    _tenant: fiscalReceipt.tenant_id,
    _fiscal_config: fiscalReceipt.fiscal_configuration_id,
    _counter_type: "gc",
    _period_key: "ALL",
  });
  if (gcRes.error || gcRes.data == null) return null;
  const dcRes = await sb.rpc("restaurant_fiscal_next_counter", {
    _tenant: fiscalReceipt.tenant_id,
    _fiscal_config: fiscalReceipt.fiscal_configuration_id,
    _counter_type: "dc",
    _period_key: znum,
  });
  if (dcRes.error || dcRes.data == null) return null;

  const numbering = {
    gc: Number(gcRes.data),
    dc: Number(dcRes.data),
    znum,
    rctDate: formatTraDate(now),
    rctTime: formatTraTime(now),
  };
  await patchFiscalReceipt(sb, fiscalReceipt.id, fiscalReceipt.tenant_id, {
    gc_number: numbering.gc,
    dc_number: numbering.dc,
    znum: numbering.znum,
    rct_date: numbering.rctDate,
    rct_time: numbering.rctTime,
  });
  return numbering;
}

/**
 * TRA requires exactly one fiscal transaction in flight per VFD at a time
 * (spec section 8). This is a best-effort, DB-visible guard across
 * processes: a receipt already "submitting" and updated recently for the
 * same VFD blocks a new submission from starting. It does not guarantee
 * strict GC-ascending delivery order under heavy concurrency — a full
 * solution would need a persisted worker queue, which is out of this
 * sprint's scope; this prevents the literal case the spec calls out
 * (simultaneously posting receipt A/B/C for the same VFD).
 */
async function isAnotherSubmissionInFlight(
  sb: Sb,
  tenantId: string,
  fiscalConfigurationId: string,
  excludeReceiptId: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const { data } = await sb
    .from("restaurant_fiscal_receipts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("fiscal_configuration_id", fiscalConfigurationId)
    .eq("state", "submitting")
    .neq("id", excludeReceiptId)
    .gte("updated_at", cutoff)
    .limit(1);
  return Boolean(data && data.length > 0);
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
    .select("device_serial, registration_info")
    .eq("tenant_id", input.tenantId)
    .eq("fiscal_configuration_id", config.id)
    .maybeSingle();

  const { data: orderItems } = await sb
    .from("restaurant_order_items")
    .select(
      "id, description, quantity, unit_price, tax_rate, tax_amount, line_total, status, tax_rule_id",
    )
    .eq("tenant_id", input.tenantId)
    .eq("order_id", order.id);

  const { data: payments } = await sb
    .from("restaurant_payments")
    .select("method, amount")
    .eq("tenant_id", input.tenantId)
    .eq("order_id", order.id);

  // Resolve each line's TRA tax classification from its tax rule's explicit
  // mapping (restaurant_tax_rules.tra_tax_code) — never assumed from the
  // rate alone beyond the one unambiguous case (18% = A), which the TRA
  // adapter itself checks; this only supplies the explicit override when a
  // taxpayer has actually configured one (spec section 6/25).
  const taxRuleIds = Array.from(
    new Set(((orderItems ?? []) as any[]).map((i) => i.tax_rule_id).filter(Boolean)),
  );
  const taxCodeByRuleId = new Map<string, string | null>();
  if (taxRuleIds.length > 0) {
    const { data: taxRules } = await sb
      .from("restaurant_tax_rules")
      .select("id, tra_tax_code")
      .eq("tenant_id", input.tenantId)
      .in("id", taxRuleIds);
    for (const r of (taxRules ?? []) as any[]) taxCodeByRuleId.set(r.id, r.tra_tax_code ?? null);
  }

  const lines = ((orderItems ?? []) as any[])
    .filter((i) => i.status !== "voided")
    .map((i) => ({
      orderItemId: i.id,
      description: String(i.description ?? ""),
      quantity: Number(i.quantity ?? 0),
      unitPrice: Number(i.unit_price ?? 0),
      taxClassificationCode: i.tax_rule_id ? (taxCodeByRuleId.get(i.tax_rule_id) ?? null) : null,
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

  // Real TRA path only (providerOverride is how this repo's own automated
  // tests inject the internal TestAdapter — see getConfiguredFiscalProvider
  // above). This is where the TRA-specific pre-flight lives: the one-at-a-
  // time VFD queue guard, registration identity, token resolution and
  // numbering allocation, none of which the generic test double needs.
  let registration: { regId: string; efdSerial: string; receiptCode: string } | null = null;
  let accessToken: string | null = null;
  let numbering: Awaited<ReturnType<typeof allocateOrReuseFiscalNumbering>> = null;

  if (providerOverride === undefined) {
    if (await isAnotherSubmissionInFlight(sb, input.tenantId, config.id, fiscalReceipt.id)) {
      fiscalReceipt = await patchFiscalReceipt(sb, fiscalReceipt.id, input.tenantId, {
        state: "retry_required",
        last_error_class: null,
        last_error_message: "Another fiscal submission for this VFD is already in flight — queued.",
        next_retry_at: new Date(Date.now() + 5_000).toISOString(),
      });
      return toStatusView(fiscalReceipt);
    }

    const reg = (device?.registration_info ?? {}) as Record<string, string>;
    if (reg.regId && reg.efdSerial && reg.receiptCode) {
      registration = { regId: reg.regId, efdSerial: reg.efdSerial, receiptCode: reg.receiptCode };
    }
    if (!registration) {
      fiscalReceipt = await markState(
        sb,
        fiscalReceipt,
        "configuration_error",
        "configuration",
        "VFD is not registered with TRA yet — register it from the Fiscal Centre before fiscalizing.",
      );
      await emitFiscalEvent(
        sb,
        userId,
        "restaurant.fiscal.submission.failed",
        order,
        fiscalReceipt,
      );
      return toStatusView(fiscalReceipt);
    }

    const tokenOutcome = await ensureTraAccessToken(sb, input.tenantId, config.id);
    if ("error" in tokenOutcome) {
      fiscalReceipt = await markState(
        sb,
        fiscalReceipt,
        TRA_ERROR_TO_FISCAL_STATE[tokenOutcome.error],
        tokenOutcome.error === "TRA_CONFIGURATION_REQUIRED" ? "configuration" : "authentication",
        tokenOutcome.message,
      );
      await emitFiscalEvent(
        sb,
        userId,
        "restaurant.fiscal.submission.failed",
        order,
        fiscalReceipt,
      );
      return toStatusView(fiscalReceipt);
    }
    accessToken = tokenOutcome.token;

    numbering = await allocateOrReuseFiscalNumbering(sb, fiscalReceipt);
    if (!numbering) {
      fiscalReceipt = await markState(
        sb,
        fiscalReceipt,
        "retry_required",
        "unknown",
        "Could not allocate fiscal numbering — will retry.",
      );
      return toStatusView(fiscalReceipt);
    }
    // Numbering allocation persists gc/dc/znum/rct_date/rct_time onto
    // fiscalReceipt's row but not onto this in-memory copy — refresh it so
    // the retry-payload check below sees the frozen values.
    fiscalReceipt = {
      ...fiscalReceipt,
      ...numbering,
      gc_number: numbering.gc,
      dc_number: numbering.dc,
    };
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
      payments: ((payments ?? []) as any[]).map((p) => ({
        method: String(p.method),
        amount: Number(p.amount ?? 0),
      })),
      items: lines,
    },
    numbering,
    registration,
    accessToken,
    existingSignedXml: fiscalReceipt.original_request_xml ?? null,
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

  // Freeze the exact signed bytes the first time they exist, whatever the
  // outcome — a retry must resend these, never rebuild (spec section 5/9).
  if ("signedXml" in result && result.signedXml && !fiscalReceipt.original_request_xml) {
    fiscalReceipt = await patchFiscalReceipt(sb, fiscalReceipt.id, input.tenantId, {
      original_request_xml: result.signedXml,
      rctvnum: "rctvnum" in result ? (result.rctvnum ?? null) : null,
    });
  }
  if ("ackCode" in result && result.ackCode) {
    fiscalReceipt = await patchFiscalReceipt(sb, fiscalReceipt.id, input.tenantId, {
      ack_code: result.ackCode,
      ack_message: "ackMessage" in result ? (result.ackMessage ?? null) : null,
    });
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
    // The adapter's own identity is authoritative — for the real TRA path
    // this IS the TRA-issued RCTVNUM (spec section 5: RCTNUM = GC, numbers
    // come from TRA/the counter allocator, never a separately-generated
    // internal document number standing in for TRA's own receipt identity).
    const receiptNumber = result.fiscalReceiptNumber;

    await sb.from("restaurant_fiscal_acknowledgements").upsert(
      {
        tenant_id: input.tenantId,
        fiscal_receipt_id: fiscalReceipt.id,
        fiscal_receipt_number: receiptNumber,
        verification_code: result.verificationCode,
        z_number: result.zNumber,
        provider_code: provider.providerCode,
        environment: config.environment,
        ack_code: "ackCode" in result ? (result.ackCode ?? null) : null,
        ack_message: "ackMessage" in result ? (result.ackMessage ?? null) : null,
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
      next_retry_at: null,
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
    result.errorClass === "configuration"
      ? "configuration_error"
      : result.outcome === "authentication_error"
        ? "authentication_error"
        : result.outcome === "network_error"
          ? "network_error"
          : "retry_required";
  fiscalReceipt = await patchFiscalReceipt(sb, fiscalReceipt.id, fiscalReceipt.tenant_id, {
    state: stateForOutcome,
    last_error_class: result.errorClass,
    last_error_message: result.reason,
    next_retry_at:
      stateForOutcome === "retry_required" || stateForOutcome === "network_error"
        ? new Date(Date.now() + 30_000).toISOString()
        : null,
  });
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

// ---------------------------------------------------------------------------
// TRA registration / connectivity / Z-report submission (spec sections 2/3/11/13)
// ---------------------------------------------------------------------------

/** Never returns REGID etc. that the caller supplied — those come from TRA alone (spec section 25). */
export async function registerFiscalVfd(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "fiscal.manage", {
    locationId: input.locationId,
  });
  const { data: config } = await sb
    .from("restaurant_fiscal_configurations")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  if (!config)
    throw new Error("Fiscal configuration not found — save the fiscal configuration first.");

  try {
    const result = await registerTraVfd(sb, input.tenantId, config.id);
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.fiscal.vfd.registered",
      tenantId: input.tenantId,
      locationId: input.locationId,
      entityType: "restaurant_fiscal_configuration",
      entityId: config.id,
      source: "restaurant-fiscal",
      payload: { ackCode: result.ackCode, regId: result.regId, efdSerial: result.efdSerial },
    });
    return result;
  } catch (err) {
    if (err instanceof TraProtocolError) throw new Error(err.message);
    throw err;
  }
}

/**
 * The ONLY thing allowed to report "Connected" — a real TRA TEST
 * authentication round trip, never a static configuration check (spec
 * section 14: "configured ≠ connected").
 */
export async function testFiscalConnection(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId: string },
): Promise<{ ok: boolean; detail: string }> {
  await assertCapability(sb, userId, input.tenantId, "fiscal.manage", {
    locationId: input.locationId,
  });
  const { data: config } = await sb
    .from("restaurant_fiscal_configurations")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  if (!config) return { ok: false, detail: "No fiscal configuration for this outlet." };

  const tokenOutcome = await ensureTraAccessToken(sb, input.tenantId, config.id);
  if ("error" in tokenOutcome) return { ok: false, detail: tokenOutcome.message };
  return {
    ok: true,
    detail: "TRA TEST authentication succeeded — a valid access token was obtained.",
  };
}

/**
 * Operator-safe registration/token view for the Fiscal Centre. Never
 * includes the TRA username, password or access token itself (spec 13/15).
 */
export async function getFiscalRegistrationStatus(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId: string },
) {
  await assertCapability(sb, userId, input.tenantId, "fiscal.view", {
    locationId: input.locationId,
  });
  const { data: config } = await sb
    .from("restaurant_fiscal_configurations")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  if (!config) return { registered: false, tokenStatus: "not_authenticated" as const };

  const { data: device } = await sb
    .from("restaurant_fiscal_devices")
    .select("registration_info, uin")
    .eq("tenant_id", input.tenantId)
    .eq("fiscal_configuration_id", config.id)
    .maybeSingle();
  const reg = (device?.registration_info ?? {}) as Record<string, string>;

  const { data: creds } = await sb
    .from("restaurant_fiscal_credentials")
    .select("expires_at")
    .eq("tenant_id", input.tenantId)
    .eq("fiscal_configuration_id", config.id)
    .maybeSingle();

  let tokenStatus: "valid" | "expired" | "not_authenticated" = "not_authenticated";
  if (creds?.expires_at) {
    tokenStatus = new Date(creds.expires_at).getTime() > Date.now() ? "valid" : "expired";
  }

  return {
    registered: Boolean(reg.regId),
    regId: reg.regId ?? null,
    efdSerial: reg.efdSerial ?? null,
    uin: device?.uin ?? null,
    receiptCode: reg.receiptCode ?? null,
    taxOffice: reg.taxOffice ?? null,
    region: reg.region ?? null,
    registeredAt: reg.registeredAt ?? null,
    tokenStatus,
  };
}

export async function submitZReportForBusinessDate(
  sb: Sb,
  userId: string,
  input: { tenantId: string; locationId: string; businessDate: string },
) {
  await assertCapability(sb, userId, input.tenantId, "fiscal.manage", {
    locationId: input.locationId,
  });
  const draft = await prepareZReportDraft(sb, userId, input);

  const { data: config } = await sb
    .from("restaurant_fiscal_configurations")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  if (!config) throw new Error("Fiscal configuration not found for this outlet.");

  try {
    const ack = await submitTraZReport(sb, input.tenantId, config.id, draft);
    return {
      ...draft,
      ackCode: ack.ackCode,
      ackMessage: ack.ackMessage,
      zNumber: ack.zNumber,
      state: ack.ackCode === "0" ? "acknowledged" : "failed",
    };
  } catch (err) {
    if (err instanceof TraProtocolError) {
      await sb
        .from("restaurant_fiscal_z_reports")
        .update({ state: "failed", ack_message: err.message })
        .eq("tenant_id", input.tenantId)
        .eq("id", draft.id);
      throw new Error(err.message);
    }
    throw err;
  }
}
