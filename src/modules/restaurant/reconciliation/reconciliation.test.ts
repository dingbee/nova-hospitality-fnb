import { describe, expect, it } from "vitest";
import {
  computeCloseTotals,
  computeItemFlows,
  dedupeDrafts,
  detectInventoryExceptions,
  detectPaymentExceptions,
  detectProcurementExceptions,
  detectSalesChainExceptions,
  detectTenderExceptions,
  reconcileTenders,
  summariseExceptions,
  type OrderFact,
  type PaymentFact,
} from "./calc";
import { cashSeverity, classifyCashVariance, draftException } from "./catalogue";

const DATE = "2026-02-10";

const order = (o: Partial<OrderFact> & { id: string }): OrderFact => ({
  status: "closed",
  payment_state: "paid",
  total: 0,
  paid_total: 0,
  ...o,
});

const payment = (p: Partial<PaymentFact> & { id: string; order_id: string }): PaymentFact => ({
  method: "cash",
  state: "captured",
  amount: 0,
  ...p,
});

describe("close totals", () => {
  it("excludes cancelled orders and nets refunds out of tender", () => {
    const totals = computeCloseTotals(
      [
        order({ id: "a", total: 100, paid_total: 100, subtotal: 90, tax_total: 10, guest_count: 2 }),
        order({ id: "b", status: "cancelled", total: 500 }),
      ],
      [
        payment({ id: "p1", order_id: "a", amount: 100 }),
        payment({ id: "p2", order_id: "a", amount: 20, refund_of: "p1" }),
      ],
      [],
    );
    expect(totals.orders).toBe(1);
    expect(totals.netSales).toBe(100);
    expect(totals.refunds).toBe(20);
    expect(totals.paymentsReceived).toBe(80);
    expect(totals.outstanding).toBe(20);
  });
});

describe("tender declaration", () => {
  it("adds the opening float to expected cash only", () => {
    const lines = reconcileTenders(
      [
        { method: "cash", captured: 100, refunded: 0, net: 100, count: 1 },
        { method: "card", captured: 50, refunded: 0, net: 50, count: 1 },
      ],
      [
        { method: "cash", declared_amount: 150 },
        { method: "card", declared_amount: 50 },
      ],
      50,
    );
    expect(lines.find((l) => l.method === "cash")).toMatchObject({ systemAmount: 150, variance: 0, outcome: "balanced" });
    expect(lines.find((l) => l.method === "card")).toMatchObject({ variance: 0 });
  });

  it("flags an undeclared tender and grades a shortage above an equal overage", () => {
    const lines = reconcileTenders(
      [{ method: "mobile", captured: 900, refunded: 0, net: 900, count: 3 }],
      [],
      0,
    );
    const drafts = detectTenderExceptions(DATE, lines);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.code).toBe("tender.declaration_missing");
    expect(cashSeverity(-500)).toBe("high");
    expect(cashSeverity(500)).toBe("medium");
    expect(classifyCashVariance(0.005)).toBe("balanced");
  });
});

describe("payment integrity", () => {
  it("detects a settled order with no payment", () => {
    const drafts = detectPaymentExceptions(DATE, [order({ id: "a", total: 120 })], []);
    expect(drafts.map((d) => d.code)).toContain("payment.missing");
  });

  it("detects duplicates and over-refunds", () => {
    const drafts = detectPaymentExceptions(
      DATE,
      [order({ id: "a", total: 100, paid_total: 100 })],
      [
        payment({ id: "p1", order_id: "a", amount: 100, client_request_id: "r1" }),
        payment({ id: "p2", order_id: "a", amount: 100, client_request_id: "r2" }),
        payment({ id: "p3", order_id: "a", amount: 150, refund_of: "p1" }),
      ],
    );
    const codes = drafts.map((d) => d.code);
    expect(codes).toContain("payment.duplicate");
    expect(codes).toContain("payment.refund_exceeds_original");
  });

  it("stays silent when payments match the order", () => {
    const drafts = detectPaymentExceptions(
      DATE,
      [order({ id: "a", total: 100, paid_total: 100 })],
      [payment({ id: "p1", order_id: "a", amount: 100 })],
    );
    expect(drafts).toHaveLength(0);
  });
});

describe("sales chain", () => {
  it("breaks on a closed order without a receipt and a receipt without money", () => {
    const drafts = detectSalesChainExceptions(
      DATE,
      [order({ id: "a", total: 100, paid_total: 100 })],
      [],
      [{ id: "r1", order_id: "a", total: 100 }],
    );
    const codes = drafts.map((d) => d.code);
    expect(codes).toContain("sales.receipt_without_payment");
    expect(codes).not.toContain("sales.closed_order_no_receipt");
  });

  it("flags orders left open and reopened after settlement", () => {
    const drafts = detectSalesChainExceptions(
      DATE,
      [
        order({ id: "a", status: "open", total: 40, payment_state: "unpaid" }),
        order({ id: "b", total: 60, paid_total: 60, reopened_at: "2026-02-10T22:00:00Z" }),
      ],
      [payment({ id: "p", order_id: "b", amount: 60 })],
      [{ id: "r", order_id: "b", total: 60 }],
    );
    const codes = drafts.map((d) => d.code);
    expect(codes).toContain("sales.order_left_open");
    expect(codes).toContain("sales.reopened_after_close");
  });
});

describe("inventory", () => {
  it("sums the ledger by direction", () => {
    const flows = computeItemFlows([
      { inventory_item_id: "i", movement_type: "purchase", quantity: 10 },
      { inventory_item_id: "i", movement_type: "sale", quantity: 3 },
      { inventory_item_id: "i", movement_type: "wastage", quantity: 1 },
    ]);
    expect(flows[0]).toMatchObject({ purchases: 10, sales: 3, waste: 1, net: 6 });
  });

  it("reports counted variance, ledger drift and negative positions", () => {
    const drafts = detectInventoryExceptions(
      DATE,
      [{ id: "l1", inventory_item_id: "i", expected_quantity: 10, counted_quantity: 8, unit_cost: 500 }],
      [{ itemId: "j", storedQuantity: -2, ledgerQuantity: -2, unitCost: 100, name: "Gin" }],
    );
    const codes = drafts.map((d) => d.code);
    expect(codes).toContain("inventory.stocktake_variance");
    expect(codes).toContain("inventory.negative_position");
    expect(drafts.find((d) => d.code === "inventory.stocktake_variance")!.impactValue).toBe(1000);
  });
});

describe("procurement", () => {
  it("surfaces open variances, missing invoices and overdue balances", () => {
    const drafts = detectProcurementExceptions(
      DATE,
      [{ id: "gr1", status: "posted", purchase_order_id: "po1", accepted_value: 4000 }],
      [
        {
          id: "inv1",
          purchase_order_id: "po2",
          status: "recorded",
          match_status: "mismatched",
          payment_status: "unpaid",
          total: 1000,
          amount_paid: 0,
          due_date: "2026-02-01",
        },
      ],
      [{ id: "v1", variance_type: "price", status: "open", variance_value: 250 }],
    );
    const codes = drafts.map((d) => d.code);
    expect(codes).toContain("procurement.price_variance");
    expect(codes).toContain("procurement.missing_invoice");
    expect(codes).toContain("procurement.invoice_mismatch");
    expect(codes).toContain("procurement.outstanding_supplier_amount");
  });
});

describe("idempotency and summary", () => {
  it("keeps one draft per finding regardless of how often it is detected", () => {
    const a = draftException("cash.shortage", DATE, "cash", { whatHappened: "x", impactValue: 10 });
    const b = draftException("cash.shortage", DATE, "cash", { whatHappened: "x again", impactValue: 10 });
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(dedupeDrafts([a, b])).toHaveLength(1);
  });

  it("summarises by domain and reports the worst severity", () => {
    const s = summariseExceptions([
      { domain: "cash", severity: "medium", impactValue: 10 },
      { domain: "payment", severity: "critical", impactValue: 90 },
    ]);
    expect(s.total).toBe(2);
    expect(s.worst).toBe("critical");
    expect(s.impactValue).toBe(100);
    expect(s.byDomain["cash"]).toBe(1);
  });
});