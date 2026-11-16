import { describe, expect, it } from "vitest";
import { calculateSupplierInvoiceMatch, type InvoiceMatchEvidence } from "./invoice-matching";

const base = (): InvoiceMatchEvidence => ({
  invoice: { currency: "TZS", subtotal: 200, taxTotal: 36, total: 236 },
  purchaseOrder: { currency: "TZS", lines: [{ id: "po-line-1", quantity: 4, unitPrice: 100 }] },
  receipts: [{ id: "receipt-line-1", purchaseOrderItemId: "po-line-1", acceptedQuantity: 2, posted: true }],
  invoiceLines: [{
    id: "invoice-line-1", purchaseOrderItemId: "po-line-1", receiptItemId: "receipt-line-1",
    description: "Cooking oil", quantity: 2, unitPrice: 100, taxAmount: 36,
  }],
});

describe("PW-08 supplier invoice reconciliation", () => {
  it("matches net line value and tax separately against a posted accepted receipt", () => {
    expect(calculateSupplierInvoiceMatch(base()).matchStatus).toBe("matched");
  });
  it("never matches across currencies", () => {
    const evidence = base();
    evidence.invoice.currency = "USD";
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain("CURRENCY_MISMATCH");
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("mismatched");
  });
  it("does not count unposted receipt lines as accepted evidence", () => {
    const evidence = base();
    evidence.receipts[0]!.posted = false;
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("unmatched");
  });
  it("rejects a receipt reference belonging to another purchase-order line", () => {
    const evidence = base();
    evidence.receipts[0]!.purchaseOrderItemId = "another-line";
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain("INVALID_RECEIPT_LINK");
  });
  it("flags invoice quantity above accepted receipt quantity", () => {
    const evidence = base();
    evidence.invoiceLines[0]!.quantity = 3;
    evidence.invoice.subtotal = 300;
    evidence.invoice.total = 336;
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain("INVOICED_ABOVE_ACCEPTED");
  });
  it("returns partial match for an installment invoice below accepted quantity", () => {
    const evidence = base();
    evidence.receipts[0]!.acceptedQuantity = 4;
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("partially_matched");
  });
  it("reconciles invoice header subtotal, tax and gross total to line totals", () => {
    const evidence = base();
    evidence.invoice.taxTotal = 20;
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain("TAX_DOES_NOT_RECONCILE");
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("mismatched");
  });
  it("does not silently accept an invoice line with no PO linkage", () => {
    const evidence = base();
    evidence.invoiceLines[0]!.purchaseOrderItemId = null;
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain("UNLINKED_PURCHASE_ORDER_LINE");
  });

  it("rejects posted receipt evidence in a different currency", () => {
    const evidence = base();
    evidence.receiptCurrencies = ["USD"];
    expect(calculateSupplierInvoiceMatch(evidence).dimensions.map((d) => d.code)).toContain("RECEIPT_CURRENCY_MISMATCH");
    expect(calculateSupplierInvoiceMatch(evidence).matchStatus).toBe("mismatched");
  });
});
