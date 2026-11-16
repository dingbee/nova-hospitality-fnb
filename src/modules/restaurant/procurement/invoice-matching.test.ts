import { describe, expect, it } from "vitest";
import { calculateSupplierInvoiceMatch, type InvoiceMatchEvidence } from "./invoice-matching";

const base = (): InvoiceMatchEvidence => ({
  invoice: { currency: "TZS", subtotal: 200, taxTotal: 36, total: 236 },
  purchaseOrder: { currency: "TZS", lines: [{ id: "po-line-1", quantity: 4, unitPrice: 100 }] },
  receipts: [
    { id: "receipt-line-1", purchaseOrderItemId: "po-line-1", acceptedQuantity: 2, posted: true },
  ],
  invoiceLines: [
    {
      id: "invoice-line-1",
      purchaseOrderItemId: "po-line-1",
      receiptItemId: "receipt-line-1",
      description: "Cooking oil",
      quantity: 2,
      unitPrice: 100,
      taxAmount: 36,
    },
  ],
});

describe("PW-08 supplier invoice reconciliation", () => {
  it("matches net line value and tax separately against a posted accepted receipt", () => {
    expect(calculateSupplierInvoiceMatch(base()).matchStatus).toBe("matched");
  });
  it("never matches across currencies", () => {
    const evidence = base();
    evidence.invoice.currency = "USD";
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "CURRENCY_MISMATCH",
    );
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("mismatched");
  });
  it("rejects an invoice line linked to a receipt that has not been posted", () => {
    const evidence = base();
    evidence.receipts[0]!.posted = false;
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "INVALID_RECEIPT_LINK",
    );
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("mismatched");
  });
  it("keeps an invoice pending when no posted receipt exists yet", () => {
    const evidence = base();
    evidence.receipts = [];
    evidence.invoiceLines[0]!.receiptItemId = null;
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("unmatched");
  });
  it("rejects a receipt reference belonging to another purchase-order line", () => {
    const evidence = base();
    evidence.receipts[0]!.purchaseOrderItemId = "another-line";
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "INVALID_RECEIPT_LINK",
    );
  });
  it("flags invoice quantity above accepted receipt quantity", () => {
    const evidence = base();
    evidence.invoiceLines[0]!.quantity = 3;
    evidence.invoice.subtotal = 300;
    evidence.invoice.total = 336;
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "INVOICED_ABOVE_ACCEPTED",
    );
  });
  it("returns partial match for an installment invoice below accepted quantity", () => {
    const evidence = base();
    evidence.receipts[0]!.acceptedQuantity = 4;
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("partially_matched");
  });
  it("reconciles invoice header subtotal, tax and gross total to line totals", () => {
    const evidence = base();
    evidence.invoice.taxTotal = 20;
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "TAX_DOES_NOT_RECONCILE",
    );
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("mismatched");
  });
  it("aggregates split invoice lines before comparing accepted quantity", () => {
    const evidence = base();
    evidence.invoiceLines.push({
      id: "invoice-line-2",
      purchaseOrderItemId: "po-line-1",
      receiptItemId: "receipt-line-1",
      description: "Cooking oil second line",
      quantity: 1,
      unitPrice: 100,
      taxAmount: 18,
    });
    evidence.invoice.subtotal = 300;
    evidence.invoice.taxTotal = 54;
    evidence.invoice.total = 354;
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "INVOICED_ABOVE_ACCEPTED",
    );
  });
  it("does not silently accept an invoice line with no PO linkage", () => {
    const evidence = base();
    evidence.invoiceLines[0]!.purchaseOrderItemId = null;
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "UNLINKED_PURCHASE_ORDER_LINE",
    );
  });

  it("rejects posted receipt evidence in a different currency", () => {
    const evidence = base();
    evidence.receiptCurrencies = ["USD"];
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "RECEIPT_CURRENCY_MISMATCH",
    );
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("mismatched");
  });

  it("accounts for earlier invoices when reconciling a later installment", () => {
    const evidence = base();
    evidence.invoiceLines[0]!.quantity = 1;
    evidence.invoice.subtotal = 100;
    evidence.invoice.total = 118;
    evidence.previouslyInvoicedQuantities = { "po-line-1": 1 };
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("matched");
  });
  it("detects cumulative overbilling across multiple invoices", () => {
    const evidence = base();
    evidence.previouslyInvoicedQuantities = { "po-line-1": 1 };
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "INVOICED_ABOVE_ACCEPTED",
    );
  });

  it("does not match an empty invoice against an existing purchase order", () => {
    const evidence = base();
    evidence.invoiceLines = [];
    evidence.invoice = { currency: "TZS", subtotal: 0, taxTotal: 0, total: 0 };
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain(
      "EMPTY_INVOICE_LINES",
    );
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("mismatched");
  });
});
