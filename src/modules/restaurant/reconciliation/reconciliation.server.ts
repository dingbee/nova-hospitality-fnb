/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 5.12 — Operational Reconciliation & Financial Control (server).
 *
 * Reconciliation is a *reader*. It never edits an order, a payment, a stock
 * position or an invoice: those belong to their owning services. It compares
 * what they recorded, writes only its own artefacts (close, declarations, run,
 * exception, audit) and asks a human to act on the difference.
 *
 * Re-running a day is safe: exceptions are keyed by finding, not by run, so a
 * second pass updates what is still true and never duplicates what is already
 * being worked on.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import {
  computeCloseTotals,
  computeItemFlows,
  dedupeDrafts,
  detectInventoryExceptions,
  detectPaymentExceptions,
  detectRoomChargeExceptions,
  detectProcurementExceptions,
  detectSalesChainExceptions,
  detectTenderExceptions,
  reconcileTenders,
  summariseExceptions,
  type ExceptionSummary,
  type LedgerPositionFact,
  type TenderLine,
} from "./calc";
import { CLOSED_EXCEPTION_STATUSES, SEVERITY_RANK, type ExceptionDraft, type ExceptionSeverity } from "./catalogue";
import type {
  closeDaySchema,
  declareTendersSchema,
  exceptionTrendSchema,
  getDailyCloseSchema,
  listDailyClosesSchema,
  listExceptionsSchema,
  listReconciliationAuditSchema,
  openDailyCloseSchema,
  reopenDaySchema,
  resolveExceptionSchema,
  runReconciliationSchema,
} from "./contracts";

type Sb = any;

/* ----------------------------------------------------------------- audit */

async function audit(
  sb: Sb,
  userId: string,
  entry: {
    tenantId: string;
    subjectType: string;
    subjectId: string;
    businessDate?: string | null;
    action: string;
    previousState?: string | null;
    newState?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const { error } = await sb.from("restaurant_reconciliation_audit").insert({
    tenant_id: entry.tenantId,
    subject_type: entry.subjectType,
    subject_id: entry.subjectId,
    business_date: entry.businessDate ?? null,
    action: entry.action,
    previous_state: entry.previousState ?? null,
    new_state: entry.newState ?? null,
    reason: entry.reason ?? null,
    actor_id: userId,
    metadata: entry.metadata ?? {},
  });
  // Losing the trail must be loud, but must not roll back a correct control action.
  if (error) console.warn("[reconciliation] audit not recorded", entry.action, error.message);
}

/* ------------------------------------------------------------ day window */

/** A business date runs 04:00 → 04:00 so late service belongs to its own day. */
const DAY_START_HOUR = 4;

export function businessDayWindow(businessDate: string): { from: string; to: string } {
  const start = new Date(`${businessDate}T00:00:00.000Z`);
  start.setUTCHours(DAY_START_HOUR);
  const end = new Date(start.getTime() + 86_400_000);
  return { from: start.toISOString(), to: end.toISOString() };
}

/* ------------------------------------------------------------- the close */

async function findClose(sb: Sb, tenantId: string, businessDate: string, locationId?: string) {
  let q = sb
    .from("restaurant_daily_closes")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("business_date", businessDate);
  q = locationId ? q.eq("location_id", locationId) : q.is("location_id", null);
  const { data } = await q.maybeSingle();
  return data ?? null;
}

export async function openDailyClose(sb: Sb, userId: string, input: z.infer<typeof openDailyCloseSchema>) {
  await assertCapability(sb, userId, input.tenantId, "reconciliation.run");
  const existing = await findClose(sb, input.tenantId, input.businessDate, input.locationId);
  if (existing) return existing;

  const { data, error } = await sb
    .from("restaurant_daily_closes")
    .insert({
      tenant_id: input.tenantId,
      location_id: input.locationId ?? null,
      business_date: input.businessDate,
      currency: input.currency,
      opening_float: input.openingFloat,
      status: "draft",
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  await audit(sb, userId, {
    tenantId: input.tenantId,
    subjectType: "daily_close",
    subjectId: data.id,
    businessDate: input.businessDate,
    action: "close.opened",
    newState: "draft",
    metadata: { openingFloat: input.openingFloat, locationId: input.locationId ?? null },
  });
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.day.close.opened",
    tenantId: input.tenantId,
    locationId: input.locationId,
    entityType: "restaurant_daily_closes",
    entityId: data.id,
    source: "restaurant-os",
    payload: { business_date: input.businessDate, opening_float: input.openingFloat },
    dedupeKey: `day.close.opened:${input.tenantId}:${input.businessDate}:${input.locationId ?? "tenant"}`,
  });
  return data;
}

/* ------------------------------------------------------------ day facts */

async function loadDayFacts(sb: Sb, tenantId: string, businessDate: string, locationId?: string) {
  const { from, to } = businessDayWindow(businessDate);

  let orderQ = sb
    .from("restaurant_orders")
    .select(
      "id, order_number, status, payment_state, order_type, guest_count, subtotal, discount_total, service_charge, tax_total, total, paid_total, cost_total, currency, opened_at, closed_at, reopened_at",
    )
    .eq("tenant_id", tenantId)
    .gte("opened_at", from)
    .lt("opened_at", to);
  if (locationId) orderQ = orderQ.eq("location_id", locationId);
  const { data: orders, error: orderErr } = await orderQ;
  if (orderErr) throw new Error(orderErr.message);

  const orderIds = ((orders ?? []) as any[]).map((o) => o.id);
  if (orderIds.length === 0) {
    return { orders: [] as any[], payments: [] as any[], receipts: [] as any[], voidedItems: 0 };
  }

  const [{ data: payments }, { data: receipts }, { data: voided }] = await Promise.all([
    sb
      .from("restaurant_payments")
      .select("id, order_id, method, state, amount, currency, reference, refund_of, client_request_id, captured_at")
      .eq("tenant_id", tenantId)
      .in("order_id", orderIds),
    sb
      .from("restaurant_receipts")
      .select("id, order_id, receipt_number, total, paid_total, issued_at, delivered_at")
      .eq("tenant_id", tenantId)
      .in("order_id", orderIds),
    sb
      .from("restaurant_order_items")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("order_id", orderIds)
      .eq("status", "voided"),
  ]);

  return {
    orders: (orders ?? []) as any[],
    payments: (payments ?? []) as any[],
    receipts: (receipts ?? []) as any[],
    voidedItems: ((voided ?? []) as any[]).length,
  };
}

export interface DailyCloseView {
  close: any | null;
  businessDate: string;
  totals: ReturnType<typeof computeCloseTotals>;
  tenders: TenderLine[];
  exceptions: any[];
  exceptionSummary: ExceptionSummary;
  lastRun: any | null;
  canClose: boolean;
  blockingReasons: string[];
}

export async function getDailyClose(
  sb: Sb,
  userId: string,
  input: z.infer<typeof getDailyCloseSchema>,
): Promise<DailyCloseView> {
  await assertTenantRead(sb, userId, input.tenantId);
  const close = await findClose(sb, input.tenantId, input.businessDate, input.locationId);
  const facts = await loadDayFacts(sb, input.tenantId, input.businessDate, input.locationId);
  const totals = computeCloseTotals(facts.orders, facts.payments, facts.receipts, {
    voidedItems: facts.voidedItems,
  });

  const [{ data: declarations }, { data: exceptions }, { data: runs }] = await Promise.all([
    close
      ? sb.from("restaurant_tender_declarations").select("*").eq("close_id", close.id)
      : Promise.resolve({ data: [] }),
    sb
      .from("restaurant_reconciliation_exceptions")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("business_date", input.businessDate)
      .order("severity", { ascending: true })
      .order("detected_at", { ascending: false }),
    sb
      .from("restaurant_reconciliation_runs")
      .select("*")
      .eq("tenant_id", input.tenantId)
      .eq("business_date", input.businessDate)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const tenders = reconcileTenders(
    totals.byMethod,
    ((declarations ?? []) as any[]).map((d) => ({ method: d.method, declared_amount: d.declared_amount })),
    Number(close?.opening_float ?? 0),
  );

  const rows = (exceptions ?? []) as any[];
  const open = rows.filter((e) => !CLOSED_EXCEPTION_STATUSES.includes(e.status));
  const blocking = open.filter((e) => SEVERITY_RANK[e.severity as ExceptionSeverity] >= SEVERITY_RANK.high);

  const blockingReasons: string[] = [];
  if (!close) blockingReasons.push("The day has not been opened for closing.");
  else if (close.status === "closed") blockingReasons.push("This business date is already closed.");
  if (totals.openOrders > 0) blockingReasons.push(`${totals.openOrders} order(s) are still open.`);
  if (tenders.some((t) => t.outcome === "undeclared"))
    blockingReasons.push("Not every tender has been declared.");
  if (blocking.length > 0)
    blockingReasons.push(`${blocking.length} high or critical exception(s) remain unresolved.`);

  return {
    close,
    businessDate: input.businessDate,
    totals,
    tenders,
    exceptions: rows,
    exceptionSummary: summariseExceptions(
      open.map((e) => ({
        domain: e.domain,
        severity: e.severity as ExceptionSeverity,
        impactValue: Number(e.impact_value ?? 0),
      })),
    ),
    lastRun: ((runs ?? []) as any[])[0] ?? null,
    canClose: blockingReasons.length === 0,
    blockingReasons,
  };
}

export async function listDailyCloses(sb: Sb, userId: string, input: z.infer<typeof listDailyClosesSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_daily_closes")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("business_date", { ascending: false })
    .limit(input.limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/* ------------------------------------------------------- tender declaring */

export async function declareTenders(sb: Sb, userId: string, input: z.infer<typeof declareTendersSchema>) {
  await assertCapability(sb, userId, input.tenantId, "reconciliation.declare");
  const { data: close, error: closeErr } = await sb
    .from("restaurant_daily_closes")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.closeId)
    .single();
  if (closeErr || !close) throw new Error("Daily close not found.");
  if (close.status === "closed") throw new Error("This day is closed. Reopen it before changing declarations.");

  const facts = await loadDayFacts(sb, input.tenantId, close.business_date, close.location_id ?? undefined);
  const totals = computeCloseTotals(facts.orders, facts.payments, facts.receipts, {
    voidedItems: facts.voidedItems,
  });
  const lines = reconcileTenders(
    totals.byMethod,
    input.declarations.map((d) => ({ method: d.method, declared_amount: d.declaredAmount })),
    Number(close.opening_float ?? 0),
  );

  const payload = input.declarations.map((d) => {
    const line = lines.find((l) => l.method === d.method)!;
    return {
      tenant_id: input.tenantId,
      close_id: close.id,
      method: d.method,
      system_amount: line.systemAmount,
      declared_amount: d.declaredAmount,
      variance: line.variance,
      currency: close.currency,
      notes: d.notes ?? null,
      declared_by: userId,
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await sb
    .from("restaurant_tender_declarations")
    .upsert(payload, { onConflict: "close_id,method" });
  if (error) throw new Error(error.message);

  const declaredVariance = Number(
    payload.reduce((s, p) => s + Number(p.variance ?? 0), 0).toFixed(2),
  );
  await sb
    .from("restaurant_daily_closes")
    .update({
      status: close.status === "draft" || close.status === "reopened" ? "declared" : close.status,
      declared_totals: Object.fromEntries(payload.map((p) => [p.method, p.declared_amount])),
      system_totals: totals as unknown as Record<string, unknown>,
      declared_variance: declaredVariance,
      declared_by: userId,
      declared_at: new Date().toISOString(),
      notes: input.notes ?? close.notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", close.id);

  await audit(sb, userId, {
    tenantId: input.tenantId,
    subjectType: "daily_close",
    subjectId: close.id,
    businessDate: close.business_date,
    action: "tender.declared",
    previousState: close.status,
    newState: "declared",
    metadata: { declarations: payload.map((p) => ({ method: p.method, declared: p.declared_amount, variance: p.variance })) },
  });
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.day.tender.declared",
    tenantId: input.tenantId,
    locationId: close.location_id ?? undefined,
    entityType: "restaurant_daily_closes",
    entityId: close.id,
    source: "restaurant-os",
    payload: { business_date: close.business_date, variance: declaredVariance, methods: payload.length },
    dedupeKey: `day.tender.declared:${close.id}:${new Date().toISOString().slice(0, 16)}`,
  });

  return { lines, declaredVariance };
}

/* ------------------------------------------------------------- the run */

async function inventoryFacts(sb: Sb, tenantId: string, businessDate: string, locationId?: string) {
  const { from, to } = businessDayWindow(businessDate);

  let stocktakeQ = sb
    .from("restaurant_stocktakes")
    .select("id, status, posted_at, counted_at, location_id")
    .eq("tenant_id", tenantId)
    .gte("created_at", from)
    .lt("created_at", to);
  if (locationId) stocktakeQ = stocktakeQ.eq("location_id", locationId);

  const [{ data: stocktakes }, { data: movements }, { data: items }] = await Promise.all([
    stocktakeQ,
    sb
      .from("restaurant_stock_movements")
      .select("inventory_item_id, movement_type, quantity, total_cost")
      .eq("tenant_id", tenantId)
      .gte("occurred_at", from)
      .lt("occurred_at", to),
    sb
      .from("restaurant_inventory_items")
      .select("id, name, current_quantity, average_cost")
      .eq("tenant_id", tenantId)
      .eq("status", "active"),
  ]);

  const stocktakeIds = ((stocktakes ?? []) as any[]).map((s) => s.id);
  let lines: any[] = [];
  if (stocktakeIds.length > 0) {
    const { data } = await sb
      .from("restaurant_stocktake_lines")
      .select("id, inventory_item_id, expected_quantity, counted_quantity, variance_quantity, unit_cost")
      .in("stocktake_id", stocktakeIds);
    lines = (data ?? []) as any[];
  }

  // Ledger drift is only meaningful for items that actually moved today.
  const flows = computeItemFlows((movements ?? []) as any[]);
  const itemById = new Map(((items ?? []) as any[]).map((i) => [i.id, i]));
  const positions: LedgerPositionFact[] = [];
  for (const item of (items ?? []) as any[]) {
    if (Number(item.current_quantity ?? 0) < 0) {
      positions.push({
        itemId: item.id,
        storedQuantity: Number(item.current_quantity ?? 0),
        ledgerQuantity: Number(item.current_quantity ?? 0),
        unitCost: Number(item.average_cost ?? 0),
        name: item.name,
      });
    }
  }

  return { lines, flows, positions, itemById };
}

async function procurementFacts(sb: Sb, tenantId: string, businessDate: string) {
  const { from, to } = businessDayWindow(businessDate);
  const [{ data: receipts }, { data: invoices }, { data: variances }] = await Promise.all([
    sb
      .from("restaurant_goods_receipts")
      .select("id, document_number, purchase_order_id, status, accepted_value, currency, posted_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", from)
      .lt("created_at", to),
    sb
      .from("restaurant_supplier_invoices")
      .select(
        "id, document_number, supplier_invoice_number, purchase_order_id, status, match_status, payment_status, total, amount_paid, due_date",
      )
      .eq("tenant_id", tenantId),
    sb
      .from("restaurant_procurement_variances")
      .select("id, variance_type, severity, status, expected_value, actual_value, variance_value, purchase_order_id")
      .eq("tenant_id", tenantId)
      .in("status", ["open", "escalated"]),
  ]);
  return {
    receipts: (receipts ?? []) as any[],
    invoices: (invoices ?? []) as any[],
    variances: (variances ?? []) as any[],
  };
}

/**
 * Persists drafts. Existing open findings are refreshed; findings a human has
 * already closed are left alone — reconciliation must not reopen a decision.
 */
async function persistExceptions(
  sb: Sb,
  userId: string,
  ctx: { tenantId: string; locationId?: string; businessDate: string; closeId: string | null; runId: string; currency: string },
  drafts: ExceptionDraft[],
): Promise<{ opened: number; existing: number }> {
  if (drafts.length === 0) return { opened: 0, existing: 0 };

  const { data: known } = await sb
    .from("restaurant_reconciliation_exceptions")
    .select("id, dedupe_key, status")
    .eq("tenant_id", ctx.tenantId)
    .in("dedupe_key", drafts.map((d) => d.dedupeKey));
  const knownByKey = new Map(((known ?? []) as any[]).map((k) => [k.dedupe_key, k]));

  let opened = 0;
  let existing = 0;
  const inserts: any[] = [];

  for (const draft of drafts) {
    const prior = knownByKey.get(draft.dedupeKey);
    if (prior) {
      existing += 1;
      if (CLOSED_EXCEPTION_STATUSES.includes(prior.status)) continue;
      await sb
        .from("restaurant_reconciliation_exceptions")
        .update({
          run_id: ctx.runId,
          severity: draft.severity,
          what_happened: draft.whatHappened,
          evidence: draft.evidence,
          impact_value: draft.impactValue,
          updated_at: new Date().toISOString(),
        })
        .eq("id", prior.id);
      continue;
    }
    opened += 1;
    inserts.push({
      tenant_id: ctx.tenantId,
      location_id: ctx.locationId ?? null,
      run_id: ctx.runId,
      close_id: ctx.closeId,
      business_date: ctx.businessDate,
      domain: draft.domain,
      code: draft.code,
      severity: draft.severity,
      status: "open",
      title: draft.title,
      what_happened: draft.whatHappened,
      evidence: draft.evidence,
      impact_value: draft.impactValue,
      currency: ctx.currency,
      required_action: draft.requiredAction,
      entity_type: draft.entityType,
      entity_id: draft.entityId,
      dedupe_key: draft.dedupeKey,
    });
  }

  if (inserts.length > 0) {
    const { error } = await sb
      .from("restaurant_reconciliation_exceptions")
      .upsert(inserts, { onConflict: "tenant_id,dedupe_key", ignoreDuplicates: true });
    if (error) throw new Error(error.message);

    for (const row of inserts) {
      await emitRestaurantEvent(sb, userId, {
        type: "restaurant.reconciliation.exception.detected",
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        entityType: "restaurant_reconciliation_exceptions",
        source: "restaurant-os",
        payload: {
          business_date: ctx.businessDate,
          domain: row.domain,
          code: row.code,
          severity: row.severity,
          impact_value: row.impact_value,
          what_happened: row.what_happened,
          required_action: row.required_action,
        },
        dedupeKey: `recon.exception:${ctx.tenantId}:${row.dedupe_key}`,
      });
    }
  }

  return { opened, existing };
}

export async function runReconciliation(sb: Sb, userId: string, input: z.infer<typeof runReconciliationSchema>) {
  await assertCapability(sb, userId, input.tenantId, "reconciliation.run");
  const close = await findClose(sb, input.tenantId, input.businessDate, input.locationId);
  const currency = close?.currency ?? "TZS";
  const scope = input.scope;
  const wants = (domain: string) => scope === "full" || scope === domain;

  const { data: run, error: runErr } = await sb
    .from("restaurant_reconciliation_runs")
    .insert({
      tenant_id: input.tenantId,
      location_id: input.locationId ?? null,
      business_date: input.businessDate,
      scope,
      run_by: userId,
    })
    .select("*")
    .single();
  if (runErr) throw new Error(runErr.message);

  const facts = await loadDayFacts(sb, input.tenantId, input.businessDate, input.locationId);
  const totals = computeCloseTotals(facts.orders, facts.payments, facts.receipts, {
    voidedItems: facts.voidedItems,
  });

  const drafts: ExceptionDraft[] = [];

  if (wants("cash") && close) {
    const { data: declarations } = await sb
      .from("restaurant_tender_declarations")
      .select("method, declared_amount, notes")
      .eq("close_id", close.id);
    const lines = reconcileTenders(
      totals.byMethod,
      (declarations ?? []) as any[],
      Number(close.opening_float ?? 0),
    );
    drafts.push(...detectTenderExceptions(input.businessDate, lines));
  }

  if (wants("payment")) {
    drafts.push(...detectPaymentExceptions(input.businessDate, facts.orders, facts.payments));
    // Room charges are only real once the folio says so: compare the outlet's
    // settlement evidence against the PMS posting log for the same orders.
    const orderIds = facts.orders.map((o: any) => o.id);
    if (orderIds.length > 0) {
      const { data: postings } = await sb
        .from("pms_folio_postings")
        .select("id, source_order_id, booking_id, amount, status, idempotency_key, failure_code")
        .in("source_order_id", orderIds);
      drafts.push(
        ...detectRoomChargeExceptions(input.businessDate, facts.payments, (postings ?? []) as any[]),
      );
    }
  }

  if (wants("sales")) {
    drafts.push(
      ...detectSalesChainExceptions(input.businessDate, facts.orders, facts.payments, facts.receipts),
    );
  }

  if (wants("inventory")) {
    const inv = await inventoryFacts(sb, input.tenantId, input.businessDate, input.locationId);
    drafts.push(...detectInventoryExceptions(input.businessDate, inv.lines, inv.positions));
  }

  if (wants("procurement")) {
    const proc = await procurementFacts(sb, input.tenantId, input.businessDate);
    drafts.push(
      ...detectProcurementExceptions(input.businessDate, proc.receipts, proc.invoices, proc.variances),
    );
  }

  const unique = dedupeDrafts(drafts);
  const summary = summariseExceptions(unique);
  const { opened, existing } = await persistExceptions(
    sb,
    userId,
    {
      tenantId: input.tenantId,
      locationId: input.locationId,
      businessDate: input.businessDate,
      closeId: close?.id ?? null,
      runId: run.id,
      currency,
    },
    unique,
  );

  await sb
    .from("restaurant_reconciliation_runs")
    .update({
      summary: { scope, totals, exceptions: summary },
      exceptions_opened: opened,
      exceptions_existing: existing,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  if (close) {
    const { data: openRows } = await sb
      .from("restaurant_reconciliation_exceptions")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .eq("business_date", input.businessDate)
      .not("status", "in", "(resolved,accepted,dismissed)");
    await sb
      .from("restaurant_daily_closes")
      .update({
        status: close.status === "closed" ? close.status : "reconciled",
        system_totals: totals as unknown as Record<string, unknown>,
        exceptions_open: ((openRows ?? []) as any[]).length,
        updated_at: new Date().toISOString(),
      })
      .eq("id", close.id);
  }

  await audit(sb, userId, {
    tenantId: input.tenantId,
    subjectType: "reconciliation_run",
    subjectId: run.id,
    businessDate: input.businessDate,
    action: "reconciliation.run",
    newState: scope,
    metadata: { opened, existing, total: unique.length },
  });
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.reconciliation.run.completed",
    tenantId: input.tenantId,
    locationId: input.locationId,
    entityType: "restaurant_reconciliation_runs",
    entityId: run.id,
    source: "restaurant-os",
    payload: {
      business_date: input.businessDate,
      scope,
      exceptions_opened: opened,
      exceptions_total: unique.length,
      net_sales: totals.netSales,
      payments_received: totals.paymentsReceived,
    },
    dedupeKey: `recon.run:${run.id}`,
  });

  return { runId: run.id, totals, summary, opened, existing };
}

/* ------------------------------------------------------------ exceptions */

export async function listExceptions(sb: Sb, userId: string, input: z.infer<typeof listExceptionsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_reconciliation_exceptions")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("detected_at", { ascending: false })
    .limit(input.limit);
  if (input.businessDate) q = q.eq("business_date", input.businessDate);
  if (input.from) q = q.gte("business_date", input.from);
  if (input.to) q = q.lte("business_date", input.to);
  if (input.domain) q = q.eq("domain", input.domain);
  if (input.code) q = q.eq("code", input.code);
  if (input.status) q = q.eq("status", input.status);
  if (input.onlyOpen) q = q.not("status", "in", "(resolved,accepted,dismissed)");
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as any[];
  return {
    rows,
    summary: summariseExceptions(
      rows
        .filter((r) => !CLOSED_EXCEPTION_STATUSES.includes(r.status))
        .map((r) => ({
          domain: r.domain,
          severity: r.severity as ExceptionSeverity,
          impactValue: Number(r.impact_value ?? 0),
        })),
    ),
  };
}

/**
 * Resolution always records *why*. An exception is never deleted: the history
 * of what disagreed and how it was settled is the point of the control.
 */
export async function resolveException(sb: Sb, userId: string, input: z.infer<typeof resolveExceptionSchema>) {
  await assertCapability(sb, userId, input.tenantId, "reconciliation.resolve");
  const { data: row, error: readErr } = await sb
    .from("restaurant_reconciliation_exceptions")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.exceptionId)
    .single();
  if (readErr || !row) throw new Error("Exception not found.");

  const terminal = CLOSED_EXCEPTION_STATUSES.includes(input.status as any);
  const { error } = await sb
    .from("restaurant_reconciliation_exceptions")
    .update({
      status: input.status,
      resolution: input.resolution ?? null,
      resolution_note: input.note,
      resolved_by: terminal ? userId : null,
      resolved_at: terminal ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);

  if (row.close_id) {
    const { data: openRows } = await sb
      .from("restaurant_reconciliation_exceptions")
      .select("id")
      .eq("close_id", row.close_id)
      .not("status", "in", "(resolved,accepted,dismissed)");
    await sb
      .from("restaurant_daily_closes")
      .update({ exceptions_open: ((openRows ?? []) as any[]).length, updated_at: new Date().toISOString() })
      .eq("id", row.close_id);
  }

  await audit(sb, userId, {
    tenantId: input.tenantId,
    subjectType: "reconciliation_exception",
    subjectId: row.id,
    businessDate: row.business_date,
    action: "exception.status_changed",
    previousState: row.status,
    newState: input.status,
    reason: input.note,
    metadata: { code: row.code, impactValue: Number(row.impact_value ?? 0) },
  });
  if (terminal) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.reconciliation.exception.resolved",
      tenantId: input.tenantId,
      locationId: row.location_id ?? undefined,
      entityType: "restaurant_reconciliation_exceptions",
      entityId: row.id,
      source: "restaurant-os",
      payload: {
        code: row.code,
        domain: row.domain,
        status: input.status,
        resolution: input.resolution ?? null,
        impact_value: Number(row.impact_value ?? 0),
        business_date: row.business_date,
      },
      dedupeKey: `recon.exception.resolved:${row.id}:${input.status}`,
    });
  }
  return { ok: true };
}

/* ------------------------------------------------------- close and reopen */

export async function closeDay(sb: Sb, userId: string, input: z.infer<typeof closeDaySchema>) {
  await assertCapability(sb, userId, input.tenantId, "reconciliation.close");
  const { data: close, error: readErr } = await sb
    .from("restaurant_daily_closes")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.closeId)
    .single();
  if (readErr || !close) throw new Error("Daily close not found.");
  if (close.status === "closed") throw new Error("This business date is already closed.");

  const view = await getDailyClose(sb, userId, {
    tenantId: input.tenantId,
    locationId: close.location_id ?? undefined,
    businessDate: close.business_date,
  });
  // A blocked close can still proceed, but only deliberately and on the record.
  const blocked = view.blockingReasons.filter((r) => !r.includes("already closed"));
  if (blocked.length > 0 && !input.overrideReason) {
    throw new Error(`Cannot close the day: ${blocked.join(" ")} Provide an override reason to proceed anyway.`);
  }

  const { error } = await sb
    .from("restaurant_daily_closes")
    .update({
      status: "closed",
      system_totals: view.totals as unknown as Record<string, unknown>,
      exceptions_open: view.exceptionSummary.total,
      notes: input.notes ?? close.notes,
      closed_by: userId,
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", close.id);
  if (error) throw new Error(error.message);

  await audit(sb, userId, {
    tenantId: input.tenantId,
    subjectType: "daily_close",
    subjectId: close.id,
    businessDate: close.business_date,
    action: "day.closed",
    previousState: close.status,
    newState: "closed",
    reason: input.overrideReason ?? null,
    metadata: {
      netSales: view.totals.netSales,
      paymentsReceived: view.totals.paymentsReceived,
      openExceptions: view.exceptionSummary.total,
      overridden: Boolean(input.overrideReason),
      blockedBy: blocked,
    },
  });
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.day.closed",
    tenantId: input.tenantId,
    locationId: close.location_id ?? undefined,
    entityType: "restaurant_daily_closes",
    entityId: close.id,
    source: "restaurant-os",
    payload: {
      business_date: close.business_date,
      net_sales: view.totals.netSales,
      payments_received: view.totals.paymentsReceived,
      declared_variance: Number(close.declared_variance ?? 0),
      open_exceptions: view.exceptionSummary.total,
      overridden: Boolean(input.overrideReason),
    },
    dedupeKey: `day.closed:${close.id}`,
  });

  return { ok: true, overridden: Boolean(input.overrideReason) };
}

export async function reopenDay(sb: Sb, userId: string, input: z.infer<typeof reopenDaySchema>) {
  await assertCapability(sb, userId, input.tenantId, "reconciliation.reopen");
  const { data: close, error: readErr } = await sb
    .from("restaurant_daily_closes")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.closeId)
    .single();
  if (readErr || !close) throw new Error("Daily close not found.");
  if (close.status !== "closed") throw new Error("Only a closed business date can be reopened.");

  const { error } = await sb
    .from("restaurant_daily_closes")
    .update({
      status: "reopened",
      reopened_by: userId,
      reopened_at: new Date().toISOString(),
      reopen_reason: input.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", close.id);
  if (error) throw new Error(error.message);

  await audit(sb, userId, {
    tenantId: input.tenantId,
    subjectType: "daily_close",
    subjectId: close.id,
    businessDate: close.business_date,
    action: "day.reopened",
    previousState: "closed",
    newState: "reopened",
    reason: input.reason,
  });
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.day.reopened",
    tenantId: input.tenantId,
    locationId: close.location_id ?? undefined,
    entityType: "restaurant_daily_closes",
    entityId: close.id,
    source: "restaurant-os",
    payload: { business_date: close.business_date, reason: input.reason },
    dedupeKey: `day.reopened:${close.id}:${new Date().toISOString().slice(0, 16)}`,
  });
  return { ok: true };
}

/* ------------------------------------------------------------- analysis */

/**
 * Repeat offenders. A pattern of the same exception is an operational problem,
 * not a series of accidents — the Intelligence Core consumes this shape.
 */
export async function exceptionTrends(sb: Sb, userId: string, input: z.infer<typeof exceptionTrendSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  const from = new Date(Date.now() - input.days * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("restaurant_reconciliation_exceptions")
    .select("code, domain, severity, status, impact_value, business_date")
    .eq("tenant_id", input.tenantId)
    .gte("business_date", from);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as any[];
  const byCode = new Map<string, { code: string; domain: string; count: number; open: number; impact: number; days: Set<string> }>();
  for (const r of rows) {
    const e =
      byCode.get(r.code) ?? { code: r.code, domain: r.domain, count: 0, open: 0, impact: 0, days: new Set<string>() };
    e.count += 1;
    if (!CLOSED_EXCEPTION_STATUSES.includes(r.status)) e.open += 1;
    e.impact += Math.abs(Number(r.impact_value ?? 0));
    e.days.add(r.business_date);
    byCode.set(r.code, e);
  }

  const recurring = [...byCode.values()]
    .map((e) => ({
      code: e.code,
      domain: e.domain,
      count: e.count,
      open: e.open,
      impactValue: Number(e.impact.toFixed(2)),
      distinctDays: e.days.size,
      /** Recurrence, not volume, is the signal: three separate days is a pattern. */
      recurring: e.days.size >= 3,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    windowDays: input.days,
    total: rows.length,
    open: rows.filter((r) => !CLOSED_EXCEPTION_STATUSES.includes(r.status)).length,
    impactValue: Number(rows.reduce((s, r) => s + Math.abs(Number(r.impact_value ?? 0)), 0).toFixed(2)),
    byCode: recurring,
  };
}

export async function listReconciliationAudit(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listReconciliationAuditSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_reconciliation_audit")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.subjectId) q = q.eq("subject_id", input.subjectId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}