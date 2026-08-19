/**
 * Sprint 5.12 — reconciliation arithmetic and chain integrity, as pure
 * functions over facts the owning services already stored.
 *
 * Nothing here reads or writes the database, so every rule is testable and
 * every number is reproducible from the same inputs. Detectors return
 * *drafts*: reconciliation proposes exceptions, people resolve them.
 */
import {
  cashSeverity,
  classifyCashVariance,
  draftException,
  MATERIALITY,
  SEVERITY_RANK,
  type ExceptionDraft,
  type ExceptionSeverity,
} from "./catalogue";

const n = (v: unknown) => Number(v ?? 0);
const round2 = (v: number) => Number(v.toFixed(2));

/* ------------------------------------------------------------------ facts */

export interface OrderFact {
  id: string;
  order_number?: string | null;
  status: string;
  payment_state?: string | null;
  order_type?: string | null;
  guest_count?: number | null;
  subtotal?: number | null;
  discount_total?: number | null;
  service_charge?: number | null;
  tax_total?: number | null;
  total?: number | null;
  paid_total?: number | null;
  cost_total?: number | null;
  currency?: string | null;
  opened_at?: string | null;
  closed_at?: string | null;
  reopened_at?: string | null;
}

export interface PaymentFact {
  id: string;
  order_id: string;
  method: string;
  state: string;
  amount?: number | null;
  currency?: string | null;
  reference?: string | null;
  refund_of?: string | null;
  client_request_id?: string | null;
  captured_at?: string | null;
}

export interface ReceiptFact {
  id: string;
  order_id: string;
  receipt_number?: string | null;
  total?: number | null;
  paid_total?: number | null;
  issued_at?: string | null;
  delivered_at?: string | null;
}

export interface DeclarationFact {
  method: string;
  declared_amount?: number | null;
  notes?: string | null;
}

/* ------------------------------------------------------- daily close maths */

export interface MethodTotal {
  method: string;
  captured: number;
  refunded: number;
  net: number;
  count: number;
}

export interface CloseTotals {
  currency: string | null;
  orders: number;
  covers: number;
  grossSales: number;
  discounts: number;
  promotions: number;
  serviceCharge: number;
  tax: number;
  refunds: number;
  netSales: number;
  paymentsReceived: number;
  outstanding: number;
  receiptsIssued: number;
  voids: number;
  reopened: number;
  cancelled: number;
  openOrders: number;
  costOfSales: number;
  byMethod: MethodTotal[];
}

const isLiveOrder = (o: OrderFact) => o.status !== "cancelled" && o.status !== "voided";

/**
 * System-calculated figures for a business date. These are never mixed with
 * staff declarations: the close record stores the two side by side.
 */
export function computeCloseTotals(
  orders: OrderFact[],
  payments: PaymentFact[],
  receipts: ReceiptFact[],
  extra: { voidedItems?: number; promotions?: number } = {},
): CloseTotals {
  const live = orders.filter(isLiveOrder);
  const sum = (key: keyof OrderFact) => round2(live.reduce((s, o) => s + n(o[key]), 0));

  const active = payments.filter((p) => p.state !== "voided" && p.state !== "failed");
  const byMethod = new Map<string, MethodTotal>();
  for (const p of active) {
    const entry = byMethod.get(p.method) ?? { method: p.method, captured: 0, refunded: 0, net: 0, count: 0 };
    const amount = n(p.amount);
    if (p.refund_of || p.state === "refunded" || amount < 0) {
      entry.refunded += Math.abs(amount);
      entry.net -= Math.abs(amount);
    } else {
      entry.captured += amount;
      entry.net += amount;
    }
    entry.count += 1;
    byMethod.set(p.method, entry);
  }
  const methods = [...byMethod.values()]
    .map((m) => ({
      ...m,
      captured: round2(m.captured),
      refunded: round2(m.refunded),
      net: round2(m.net),
    }))
    .sort((a, b) => b.net - a.net);

  const netSales = sum("total");
  const received = round2(methods.reduce((s, m) => s + m.net, 0));

  return {
    currency: live[0]?.currency ?? orders[0]?.currency ?? null,
    orders: live.length,
    covers: live.reduce((s, o) => s + n(o.guest_count), 0),
    grossSales: sum("subtotal"),
    discounts: sum("discount_total"),
    promotions: round2(extra.promotions ?? 0),
    serviceCharge: sum("service_charge"),
    tax: sum("tax_total"),
    refunds: round2(methods.reduce((s, m) => s + m.refunded, 0)),
    netSales,
    paymentsReceived: received,
    outstanding: round2(netSales - received),
    receiptsIssued: receipts.length,
    voids: extra.voidedItems ?? 0,
    reopened: orders.filter((o) => Boolean(o.reopened_at)).length,
    cancelled: orders.filter((o) => o.status === "cancelled").length,
    openOrders: orders.filter((o) => !["closed", "cancelled", "voided"].includes(String(o.status))).length,
    costOfSales: sum("cost_total"),
    byMethod: methods,
  };
}

export interface TenderLine {
  method: string;
  systemAmount: number;
  declaredAmount: number | null;
  variance: number;
  outcome: "balanced" | "overage" | "shortage" | "undeclared";
}

/**
 * Declared tender against system tender. Cash carries the opening float,
 * because the drawer physically contains it at count time.
 */
export function reconcileTenders(
  system: MethodTotal[],
  declarations: DeclarationFact[],
  openingFloat = 0,
): TenderLine[] {
  const declared = new Map(declarations.map((d) => [d.method, d]));
  const methods = new Set<string>([...system.map((s) => s.method), ...declared.keys()]);

  return [...methods].sort().map((method) => {
    const sys = system.find((s) => s.method === method);
    const expected = round2(n(sys?.net) + (method === "cash" ? openingFloat : 0));
    const decl = declared.get(method);
    if (!decl || decl.declared_amount == null) {
      return { method, systemAmount: expected, declaredAmount: null, variance: 0, outcome: "undeclared" as const };
    }
    const variance = round2(n(decl.declared_amount) - expected);
    return {
      method,
      systemAmount: expected,
      declaredAmount: round2(n(decl.declared_amount)),
      variance,
      outcome: classifyCashVariance(variance) as "balanced" | "overage" | "shortage",
    };
  });
}

/* ------------------------------------------------------ payment detectors */

export function detectTenderExceptions(
  businessDate: string,
  lines: TenderLine[],
  currencyless = false,
): ExceptionDraft[] {
  const out: ExceptionDraft[] = [];
  for (const line of lines) {
    if (line.outcome === "undeclared") {
      if (Math.abs(line.systemAmount) <= MATERIALITY.moneyEpsilon) continue;
      out.push(
        draftException("tender.declaration_missing", businessDate, line.method, {
          whatHappened: `${line.method} took ${line.systemAmount} but no counted amount was declared at close.`,
          evidence: { method: line.method, systemAmount: line.systemAmount, currencyless },
          impactValue: line.systemAmount,
        }),
      );
      continue;
    }
    if (line.outcome === "balanced") continue;
    const code = line.variance > 0 ? "cash.overage" : "cash.shortage";
    out.push(
      draftException(code, businessDate, line.method, {
        whatHappened: `${line.method} declared ${line.declaredAmount} against an expected ${line.systemAmount} — a ${
          line.variance > 0 ? "overage" : "shortage"
        } of ${Math.abs(line.variance)}.`,
        evidence: {
          method: line.method,
          declared: line.declaredAmount,
          expected: line.systemAmount,
          variance: line.variance,
        },
        impactValue: Math.abs(line.variance),
        severity: cashSeverity(line.variance),
      }),
    );
  }
  return out;
}

export function detectPaymentExceptions(
  businessDate: string,
  orders: OrderFact[],
  payments: PaymentFact[],
): ExceptionDraft[] {
  const out: ExceptionDraft[] = [];
  const byOrder = new Map<string, PaymentFact[]>();
  for (const p of payments) {
    byOrder.set(p.order_id, [...(byOrder.get(p.order_id) ?? []), p]);
  }
  const byId = new Map(payments.map((p) => [p.id, p]));

  // Duplicates: same order, method and amount captured twice.
  const seen = new Map<string, PaymentFact>();
  for (const p of payments) {
    if (p.refund_of || p.state === "voided" || p.state === "failed") continue;
    const key = `${p.order_id}|${p.method}|${round2(n(p.amount))}`;
    const first = seen.get(key);
    if (first && first.client_request_id !== p.client_request_id) {
      out.push(
        draftException("payment.duplicate", businessDate, p.id, {
          whatHappened: `Two ${p.method} payments of ${round2(n(p.amount))} were captured against the same order.`,
          evidence: { orderId: p.order_id, firstPaymentId: first.id, duplicatePaymentId: p.id, amount: n(p.amount) },
          impactValue: Math.abs(n(p.amount)),
          entityType: "restaurant_payments",
          entityId: p.id,
        }),
      );
    } else if (!first) {
      seen.set(key, p);
    }
  }

  // Refund integrity.
  for (const p of payments) {
    if (!p.refund_of) continue;
    const original = byId.get(p.refund_of);
    if (!original) {
      out.push(
        draftException("payment.refund_without_original", businessDate, p.id, {
          whatHappened: `A refund of ${Math.abs(n(p.amount))} references a payment that cannot be found.`,
          evidence: { paymentId: p.id, refundOf: p.refund_of, amount: n(p.amount) },
          impactValue: Math.abs(n(p.amount)),
          entityType: "restaurant_payments",
          entityId: p.id,
        }),
      );
      continue;
    }
    const refunded = payments
      .filter((r) => r.refund_of === original.id)
      .reduce((s, r) => s + Math.abs(n(r.amount)), 0);
    if (refunded - n(original.amount) > MATERIALITY.moneyEpsilon) {
      out.push(
        draftException("payment.refund_exceeds_original", businessDate, original.id, {
          whatHappened: `Refunds of ${round2(refunded)} exceed the original ${p.method} payment of ${round2(
            n(original.amount),
          )}.`,
          evidence: { originalPaymentId: original.id, refunded: round2(refunded), original: n(original.amount) },
          impactValue: round2(refunded - n(original.amount)),
          entityType: "restaurant_payments",
          entityId: original.id,
        }),
      );
    }
  }

  // Order-level settlement integrity.
  for (const order of orders.filter(isLiveOrder)) {
    const rows = (byOrder.get(order.id) ?? []).filter((p) => p.state !== "voided" && p.state !== "failed");
    const captured = round2(
      rows.reduce((s, p) => s + (p.refund_of ? -Math.abs(n(p.amount)) : n(p.amount)), 0),
    );
    const settled = order.payment_state === "paid" || order.status === "closed";

    if (settled && rows.length === 0 && n(order.total) > MATERIALITY.moneyEpsilon) {
      out.push(
        draftException("payment.missing", businessDate, order.id, {
          whatHappened: `Order ${order.order_number ?? order.id} is settled for ${n(
            order.total,
          )} but carries no payment record.`,
          evidence: { orderId: order.id, total: n(order.total), paidTotal: n(order.paid_total) },
          impactValue: n(order.total),
          entityType: "restaurant_orders",
          entityId: order.id,
        }),
      );
      continue;
    }

    if (rows.length > 0 && Math.abs(captured - n(order.paid_total)) > MATERIALITY.moneyEpsilon) {
      out.push(
        draftException("payment.amount_mismatch", businessDate, order.id, {
          whatHappened: `Captured payments total ${captured} while the order records ${n(
            order.paid_total,
          )} as paid.`,
          evidence: { orderId: order.id, captured, paidTotal: n(order.paid_total) },
          impactValue: Math.abs(captured - n(order.paid_total)),
          entityType: "restaurant_orders",
          entityId: order.id,
        }),
      );
    }
  }

  return out;
}

/* -------------------------------------------------------- sales chain */

/**
 * Order → closed → bill → payment → receipt. A break anywhere in that chain is
 * an exception even when the money happens to add up.
 */
export function detectSalesChainExceptions(
  businessDate: string,
  orders: OrderFact[],
  payments: PaymentFact[],
  receipts: ReceiptFact[],
): ExceptionDraft[] {
  const out: ExceptionDraft[] = [];
  const receiptByOrder = new Map(receipts.map((r) => [r.order_id, r]));
  const paidByOrder = new Map<string, number>();
  for (const p of payments) {
    if (p.state === "voided" || p.state === "failed") continue;
    const delta = p.refund_of ? -Math.abs(n(p.amount)) : n(p.amount);
    paidByOrder.set(p.order_id, round2((paidByOrder.get(p.order_id) ?? 0) + delta));
  }

  for (const order of orders) {
    if (order.status === "cancelled" || order.status === "voided") continue;

    if (order.status === "closed" && !receiptByOrder.has(order.id)) {
      out.push(
        draftException("sales.closed_order_no_receipt", businessDate, order.id, {
          whatHappened: `Order ${order.order_number ?? order.id} closed at ${
            order.closed_at ?? "an unrecorded time"
          } without a receipt.`,
          evidence: { orderId: order.id, total: n(order.total) },
          impactValue: n(order.total),
          entityType: "restaurant_orders",
          entityId: order.id,
        }),
      );
    }

    if (order.status !== "closed") {
      out.push(
        draftException("sales.order_left_open", businessDate, order.id, {
          whatHappened: `Order ${order.order_number ?? order.id} is still "${order.status}" for a business date being closed.`,
          evidence: { orderId: order.id, status: order.status, total: n(order.total) },
          impactValue: n(order.total),
          severity: n(order.total) > 0 ? "medium" : "low",
          entityType: "restaurant_orders",
          entityId: order.id,
        }),
      );
    }

    const paid = paidByOrder.get(order.id) ?? 0;
    const outstanding = round2(n(order.total) - paid);
    if (order.payment_state === "paid" && outstanding > MATERIALITY.moneyEpsilon) {
      out.push(
        draftException("sales.paid_bill_outstanding", businessDate, order.id, {
          whatHappened: `Order ${order.order_number ?? order.id} is marked paid but ${outstanding} remains unsettled.`,
          evidence: { orderId: order.id, total: n(order.total), paid, outstanding },
          impactValue: outstanding,
          entityType: "restaurant_orders",
          entityId: order.id,
        }),
      );
    }

    if (order.reopened_at) {
      out.push(
        draftException("sales.reopened_after_close", businessDate, order.id, {
          whatHappened: `Order ${order.order_number ?? order.id} was reopened at ${order.reopened_at} after settlement.`,
          evidence: { orderId: order.id, reopenedAt: order.reopened_at, total: n(order.total) },
          impactValue: n(order.total),
          entityType: "restaurant_orders",
          entityId: order.id,
        }),
      );
    }
  }

  for (const receipt of receipts) {
    const paid = paidByOrder.get(receipt.order_id) ?? 0;
    if (paid <= MATERIALITY.moneyEpsilon && n(receipt.total) > MATERIALITY.moneyEpsilon) {
      out.push(
        draftException("sales.receipt_without_payment", businessDate, receipt.id, {
          whatHappened: `Receipt ${receipt.receipt_number ?? receipt.id} was issued for ${n(
            receipt.total,
          )} with no settled payment behind it.`,
          evidence: { receiptId: receipt.id, orderId: receipt.order_id, total: n(receipt.total), paid },
          impactValue: n(receipt.total),
          entityType: "restaurant_receipts",
          entityId: receipt.id,
        }),
      );
    }
  }

  return out;
}

/* ---------------------------------------------------------- inventory */

export interface MovementFact {
  inventory_item_id: string;
  movement_type: string;
  quantity?: number | null;
  total_cost?: number | null;
}

export interface ItemFlow {
  itemId: string;
  purchases: number;
  sales: number;
  waste: number;
  transfersIn: number;
  transfersOut: number;
  production: number;
  adjustments: number;
  stocktake: number;
  net: number;
}

const SIGN: Record<string, 1 | -1> = {
  purchase: 1,
  receipt: 1,
  transfer_in: 1,
  production_output: 1,
  return_in: 1,
  sale: -1,
  consumption: -1,
  wastage: -1,
  waste: -1,
  transfer_out: -1,
  production_input: -1,
  issue: -1,
};

/**
 * Expected movement per item, derived only from the ledger. This never becomes
 * a stored balance — it is the arithmetic the ledger already implies.
 */
export function computeItemFlows(movements: MovementFact[]): ItemFlow[] {
  const map = new Map<string, ItemFlow>();
  for (const m of movements) {
    const flow: ItemFlow =
      map.get(m.inventory_item_id) ??
      {
        itemId: m.inventory_item_id,
        purchases: 0,
        sales: 0,
        waste: 0,
        transfersIn: 0,
        transfersOut: 0,
        production: 0,
        adjustments: 0,
        stocktake: 0,
        net: 0,
      };
    const qty = Math.abs(n(m.quantity));
    const type = String(m.movement_type);
    const sign = SIGN[type] ?? (n(m.quantity) < 0 ? -1 : 1);

    if (type === "purchase" || type === "receipt") flow.purchases += qty;
    else if (type === "sale" || type === "consumption" || type === "issue") flow.sales += qty;
    else if (type === "wastage" || type === "waste") flow.waste += qty;
    else if (type === "transfer_in") flow.transfersIn += qty;
    else if (type === "transfer_out") flow.transfersOut += qty;
    else if (type.startsWith("production")) flow.production += qty * sign;
    else if (type === "stocktake") flow.stocktake += n(m.quantity);
    else flow.adjustments += n(m.quantity);

    flow.net += type === "stocktake" || type === "adjustment" ? n(m.quantity) : qty * sign;
    map.set(m.inventory_item_id, flow);
  }
  return [...map.values()].map((f) => ({ ...f, net: Number(f.net.toFixed(6)) }));
}

export interface StocktakeLineFact {
  id: string;
  inventory_item_id: string;
  expected_quantity?: number | null;
  counted_quantity?: number | null;
  variance_quantity?: number | null;
  unit_cost?: number | null;
}

export interface LedgerPositionFact {
  itemId: string;
  storedQuantity: number;
  ledgerQuantity: number;
  unitCost?: number | null;
  name?: string | null;
}

export function detectInventoryExceptions(
  businessDate: string,
  lines: StocktakeLineFact[],
  positions: LedgerPositionFact[],
): ExceptionDraft[] {
  const out: ExceptionDraft[] = [];

  for (const line of lines) {
    const variance =
      line.variance_quantity != null
        ? n(line.variance_quantity)
        : round2(n(line.counted_quantity) - n(line.expected_quantity));
    if (Math.abs(variance) <= MATERIALITY.quantityEpsilon) continue;
    const value = Math.abs(variance) * n(line.unit_cost);
    out.push(
      draftException("inventory.stocktake_variance", businessDate, line.id, {
        whatHappened: `Counted ${n(line.counted_quantity)} against an expected ${n(
          line.expected_quantity,
        )} — a variance of ${round2(variance)}.`,
        evidence: {
          stocktakeLineId: line.id,
          itemId: line.inventory_item_id,
          expected: n(line.expected_quantity),
          counted: n(line.counted_quantity),
          variance: round2(variance),
        },
        impactValue: value,
        severity: value >= MATERIALITY.cashHigh ? "high" : "medium",
        entityType: "restaurant_stocktake_lines",
        entityId: line.id,
      }),
    );
  }

  for (const p of positions) {
    const drift = p.storedQuantity - p.ledgerQuantity;
    if (Math.abs(drift) > MATERIALITY.quantityEpsilon) {
      out.push(
        draftException("inventory.ledger_drift", businessDate, p.itemId, {
          whatHappened: `${p.name ?? "Item"} stores ${p.storedQuantity} but the movement ledger sums to ${p.ledgerQuantity}.`,
          evidence: { itemId: p.itemId, stored: p.storedQuantity, ledger: p.ledgerQuantity, drift },
          impactValue: Math.abs(drift) * n(p.unitCost),
          entityType: "restaurant_inventory_items",
          entityId: p.itemId,
        }),
      );
    }
    if (p.ledgerQuantity < -MATERIALITY.quantityEpsilon) {
      out.push(
        draftException("inventory.negative_position", businessDate, `${p.itemId}:negative`, {
          whatHappened: `${p.name ?? "Item"} holds a negative ledger position of ${p.ledgerQuantity}.`,
          evidence: { itemId: p.itemId, ledger: p.ledgerQuantity },
          impactValue: Math.abs(p.ledgerQuantity) * n(p.unitCost),
          entityType: "restaurant_inventory_items",
          entityId: p.itemId,
        }),
      );
    }
  }

  return out;
}

/* -------------------------------------------------------- procurement */

export interface GoodsReceiptFact {
  id: string;
  document_number?: string | null;
  purchase_order_id?: string | null;
  status: string;
  accepted_value?: number | null;
  currency?: string | null;
  posted_at?: string | null;
}

export interface InvoiceFact {
  id: string;
  document_number?: string | null;
  supplier_invoice_number?: string | null;
  purchase_order_id?: string | null;
  status: string;
  match_status?: string | null;
  payment_status?: string | null;
  total?: number | null;
  amount_paid?: number | null;
  due_date?: string | null;
}

export interface ProcurementVarianceFact {
  id: string;
  variance_type: string;
  severity?: string | null;
  status: string;
  label?: string | null;
  expected_value?: number | null;
  actual_value?: number | null;
  variance_value?: number | null;
  purchase_order_id?: string | null;
}

const VARIANCE_CODE: Record<string, "procurement.quantity_variance" | "procurement.price_variance" | "procurement.quality_rejection" | "procurement.invoice_mismatch"> = {
  quantity: "procurement.quantity_variance",
  price: "procurement.price_variance",
  quality: "procurement.quality_rejection",
  invoice: "procurement.invoice_mismatch",
};

/**
 * Reuses the three-way matching the procurement module already performed:
 * this surfaces what remains unresolved, it does not re-match.
 */
export function detectProcurementExceptions(
  businessDate: string,
  receipts: GoodsReceiptFact[],
  invoices: InvoiceFact[],
  variances: ProcurementVarianceFact[],
): ExceptionDraft[] {
  const out: ExceptionDraft[] = [];
  const invoicedOrders = new Set(invoices.map((i) => i.purchase_order_id).filter(Boolean) as string[]);

  for (const v of variances) {
    if (v.status !== "open" && v.status !== "escalated") continue;
    const code = VARIANCE_CODE[v.variance_type] ?? "procurement.invoice_mismatch";
    out.push(
      draftException(code, businessDate, v.id, {
        whatHappened:
          v.label ??
          `An unresolved ${v.variance_type} variance of ${n(v.variance_value)} is open against this order.`,
        evidence: {
          varianceId: v.id,
          type: v.variance_type,
          expected: n(v.expected_value),
          actual: n(v.actual_value),
          purchaseOrderId: v.purchase_order_id,
        },
        impactValue: Math.abs(n(v.variance_value)),
        severity: v.status === "escalated" ? "high" : (v.severity as ExceptionSeverity | undefined) ?? undefined,
        entityType: "restaurant_procurement_variances",
        entityId: v.id,
      }),
    );
  }

  for (const r of receipts) {
    if (r.status !== "posted") continue;
    if (r.purchase_order_id && invoicedOrders.has(r.purchase_order_id)) continue;
    out.push(
      draftException("procurement.missing_invoice", businessDate, r.id, {
        whatHappened: `Goods receipt ${r.document_number ?? r.id} accepted ${n(
          r.accepted_value,
        )} of stock with no supplier invoice recorded.`,
        evidence: { receiptId: r.id, purchaseOrderId: r.purchase_order_id, acceptedValue: n(r.accepted_value) },
        impactValue: n(r.accepted_value),
        entityType: "restaurant_goods_receipts",
        entityId: r.id,
      }),
    );
  }

  for (const i of invoices) {
    if (i.match_status === "mismatched") {
      out.push(
        draftException("procurement.invoice_mismatch", businessDate, i.id, {
          whatHappened: `Invoice ${i.supplier_invoice_number ?? i.document_number ?? i.id} does not match the order and receipt.`,
          evidence: { invoiceId: i.id, total: n(i.total), matchStatus: i.match_status },
          impactValue: n(i.total),
          entityType: "restaurant_supplier_invoices",
          entityId: i.id,
        }),
      );
    }
    const outstanding = round2(n(i.total) - n(i.amount_paid));
    const overdue = Boolean(i.due_date && i.due_date < businessDate);
    if (overdue && i.payment_status !== "paid" && outstanding > MATERIALITY.moneyEpsilon) {
      out.push(
        draftException("procurement.outstanding_supplier_amount", businessDate, i.id, {
          whatHappened: `Invoice ${i.supplier_invoice_number ?? i.id} was due ${i.due_date} with ${outstanding} outstanding.`,
          evidence: { invoiceId: i.id, dueDate: i.due_date, outstanding },
          impactValue: outstanding,
          entityType: "restaurant_supplier_invoices",
          entityId: i.id,
        }),
      );
    }
  }

  return out;
}

/* ------------------------------------------------------------- summary */

export interface ExceptionSummary {
  total: number;
  byDomain: Record<string, number>;
  bySeverity: Record<string, number>;
  worst: ExceptionSeverity | null;
  impactValue: number;
}

export function summariseExceptions(
  drafts: { domain: string; severity: ExceptionSeverity; impactValue: number }[],
): ExceptionSummary {
  const byDomain: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let worst: ExceptionSeverity | null = null;
  for (const d of drafts) {
    byDomain[d.domain] = (byDomain[d.domain] ?? 0) + 1;
    bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1;
    if (!worst || SEVERITY_RANK[d.severity] > SEVERITY_RANK[worst]) worst = d.severity;
  }
  return {
    total: drafts.length,
    byDomain,
    bySeverity,
    worst,
    impactValue: round2(drafts.reduce((s, d) => s + Math.abs(d.impactValue), 0)),
  };
}

/** Deduplicates drafts produced by overlapping detectors within one run. */
export function dedupeDrafts(drafts: ExceptionDraft[]): ExceptionDraft[] {
  const seen = new Map<string, ExceptionDraft>();
  for (const d of drafts) if (!seen.has(d.dedupeKey)) seen.set(d.dedupeKey, d);
  return [...seen.values()];
}
/* ------------------------------------------------- room charge / folio ---- */

export interface FolioPostingFact {
  id: string;
  source_order_id?: string | null;
  booking_id?: string | null;
  amount?: number | null;
  status: string;
  idempotency_key?: string | null;
  failure_code?: string | null;
}

/**
 * The two ways a room charge can go wrong, and neither is allowed to pass
 * silently: money settled in the outlet that never reached the folio, and money
 * on a guest's folio that never settled the outlet bill.
 */
export function detectRoomChargeExceptions(
  businessDate: string,
  payments: PaymentFact[],
  postings: FolioPostingFact[],
): ExceptionDraft[] {
  const out: ExceptionDraft[] = [];
  const roomCharges = payments.filter(
    (p) => p.method === "room_charge" && !p.refund_of && p.state !== "voided" && p.state !== "failed",
  );
  const postedByOrder = new Map<string, FolioPostingFact[]>();
  for (const post of postings) {
    if (!post.source_order_id) continue;
    postedByOrder.set(post.source_order_id, [...(postedByOrder.get(post.source_order_id) ?? []), post]);
  }

  for (const p of roomCharges) {
    const related = postedByOrder.get(p.order_id) ?? [];
    const posted = related.filter((r) => r.status === "posted");
    const settledAmount = posted.reduce((s, r) => s + n(r.amount), 0);
    if (posted.length === 0) {
      const unresolved = related.find((r) => r.status === "unknown" || r.status === "pending");
      out.push(
        draftException(
          unresolved ? "payment.room_charge_unknown" : "payment.room_charge_unposted",
          businessDate,
          p.id,
          {
            whatHappened: unresolved
              ? `A room charge of ${round2(n(p.amount))} was attempted but the property system never confirmed it.`
              : `A room charge of ${round2(n(p.amount))} settled the bill with no folio posting behind it.`,
            evidence: { orderId: p.order_id, paymentId: p.id, amount: n(p.amount), postings: related.map((r) => r.id) },
            impactValue: Math.abs(n(p.amount)),
            entityType: "restaurant_payments",
            entityId: p.id,
          },
        ),
      );
      continue;
    }
    if (Math.abs(settledAmount - n(p.amount)) > MATERIALITY.moneyEpsilon) {
      out.push(
        draftException("payment.amount_mismatch", businessDate, `roomcharge:${p.id}`, {
          whatHappened: `A room charge of ${round2(n(p.amount))} does not match the ${round2(settledAmount)} posted to the folio.`,
          evidence: { orderId: p.order_id, paymentId: p.id, paid: n(p.amount), posted: settledAmount },
          impactValue: Math.abs(settledAmount - n(p.amount)),
          entityType: "restaurant_payments",
          entityId: p.id,
        }),
      );
    }
  }

  const chargedOrders = new Set(roomCharges.map((p) => p.order_id));
  for (const post of postings) {
    if (post.status !== "posted" || !post.source_order_id) continue;
    if (chargedOrders.has(post.source_order_id)) continue;
    out.push(
      draftException("payment.room_charge_orphaned", businessDate, post.id, {
        whatHappened: `A guest folio was charged ${round2(n(post.amount))} but the outlet bill was never settled.`,
        evidence: { postingId: post.id, orderId: post.source_order_id, bookingId: post.booking_id, amount: n(post.amount) },
        impactValue: Math.abs(n(post.amount)),
        entityType: "pms_folio_postings",
        entityId: post.id,
      }),
    );
  }
  return out;
}
