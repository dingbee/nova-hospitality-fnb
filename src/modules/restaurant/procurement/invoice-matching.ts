/**
 * PW-08 deterministic supplier invoice reconciliation.
 * This module is pure: it evaluates evidence supplied by the server layer and
 * never reads, writes, approves, or mutates procurement records.
 */
export type InvoiceMatchStatus = "unmatched" | "matched" | "partially_matched" | "mismatched";
export type InvoiceVarianceDimension = "quantity" | "price" | "tax" | "invoice";

export interface InvoiceMatchLine {
  id: string;
  purchaseOrderItemId: string | null;
  receiptItemId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxAmount: number;
}
export interface PurchaseOrderMatchLine {
  id: string;
  quantity: number;
  unitPrice: number;
}
export interface ReceiptMatchLine {
  id: string;
  purchaseOrderItemId: string | null;
  acceptedQuantity: number;
  posted: boolean;
}
export interface InvoiceMatchEvidence {
  invoice: { currency: string; subtotal: number; taxTotal: number; total: number };
  purchaseOrder: { currency: string; lines: PurchaseOrderMatchLine[] } | null;
  receipts: ReceiptMatchLine[];
  invoiceLines: InvoiceMatchLine[];
  receiptCurrencies?: string[];
  previouslyInvoicedQuantities?: Record<string, number>;
}
export interface InvoiceMatchDimension {
  dimension: InvoiceVarianceDimension;
  code: string;
  label: string;
  expected: number | null;
  actual: number | null;
}
export interface InvoiceMatchResult {
  matchStatus: InvoiceMatchStatus;
  dimensions: InvoiceMatchDimension[];
  netSubtotal: number;
  taxTotal: number;
  grossTotal: number;
  acceptedLineCount: number;
  partiallyMatchedLineCount: number;
  pendingLineCount: number;
}

const EPSILON = 0.0001;
const MONEY_TOLERANCE = 0.01;
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const valid = (value: number) => Number.isFinite(value) && value >= 0;
const currency = (value: string) => value.trim().toUpperCase();

export function calculateSupplierInvoiceMatch(evidence: InvoiceMatchEvidence): InvoiceMatchResult {
  const { invoice, purchaseOrder, receipts, invoiceLines } = evidence;
  const dimensions: InvoiceMatchDimension[] = [];
  const add = (
    dimension: InvoiceVarianceDimension,
    code: string,
    label: string,
    expected: number | null = null,
    actual: number | null = null,
  ) => dimensions.push({ dimension, code, label, expected, actual });

  const values = [invoice.subtotal, invoice.taxTotal, invoice.total];
  if (values.some((v) => !valid(v))) {
    add(
      "invoice",
      "INVALID_HEADER_AMOUNT",
      "Invoice header contains a negative or non-finite amount.",
    );
  }
  if (invoiceLines.length === 0 && purchaseOrder) {
    add(
      "invoice",
      "EMPTY_INVOICE_LINES",
      "A purchase-order invoice must contain at least one line before it can be matched.",
    );
  }
  const computedNet = money(
    invoiceLines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
  );
  const computedTax = money(invoiceLines.reduce((sum, line) => sum + line.taxAmount, 0));
  const computedGross = money(computedNet + computedTax);
  if (Math.abs(computedNet - money(invoice.subtotal)) > MONEY_TOLERANCE) {
    add(
      "invoice",
      "SUBTOTAL_DOES_NOT_RECONCILE",
      "Invoice subtotal does not equal the sum of invoice line net amounts.",
      computedNet,
      invoice.subtotal,
    );
  }
  if (Math.abs(computedTax - money(invoice.taxTotal)) > MONEY_TOLERANCE) {
    add(
      "tax",
      "TAX_DOES_NOT_RECONCILE",
      "Invoice tax total does not equal the sum of line tax amounts.",
      computedTax,
      invoice.taxTotal,
    );
  }
  if (Math.abs(computedGross - money(invoice.total)) > MONEY_TOLERANCE) {
    add(
      "invoice",
      "GROSS_TOTAL_DOES_NOT_RECONCILE",
      "Invoice total does not equal subtotal plus tax.",
      computedGross,
      invoice.total,
    );
  }

  if (!purchaseOrder) {
    return {
      matchStatus: dimensions.length ? "mismatched" : "unmatched",
      dimensions,
      netSubtotal: computedNet,
      taxTotal: computedTax,
      grossTotal: computedGross,
      acceptedLineCount: 0,
      partiallyMatchedLineCount: 0,
      pendingLineCount: invoiceLines.length,
    };
  }

  if (currency(invoice.currency) !== currency(purchaseOrder.currency)) {
    add(
      "invoice",
      "CURRENCY_MISMATCH",
      "Invoice and purchase order currencies differ; conversion is not inferred.",
    );
  }
  if (
    (evidence.receiptCurrencies ?? []).some(
      (value) => currency(value) !== currency(invoice.currency),
    )
  ) {
    add(
      "invoice",
      "RECEIPT_CURRENCY_MISMATCH",
      "Invoice and posted receipt currencies differ; conversion is not inferred.",
    );
  }

  const orderById = new Map(purchaseOrder.lines.map((line) => [line.id, line]));
  const postedReceipts = receipts.filter((line) => line.posted);
  const acceptedByOrderLine = new Map<string, number>();
  const receiptById = new Map<string, ReceiptMatchLine>();
  for (const receipt of postedReceipts) {
    receiptById.set(receipt.id, receipt);
    if (receipt.purchaseOrderItemId) {
      acceptedByOrderLine.set(
        receipt.purchaseOrderItemId,
        (acceptedByOrderLine.get(receipt.purchaseOrderItemId) ?? 0) + receipt.acceptedQuantity,
      );
    }
  }

  let acceptedLineCount = 0;
  let partiallyMatchedLineCount = 0;
  let pendingLineCount = 0;
  const invoicedByOrderLine = new Map<string, number>();
  const pendingOrderLineIds = new Set<string>();
  for (const line of invoiceLines) {
    if (
      !valid(line.quantity) ||
      line.quantity <= 0 ||
      !valid(line.unitPrice) ||
      !valid(line.taxAmount)
    ) {
      add(
        "invoice",
        "INVALID_LINE_AMOUNT",
        line.description + ": invoice line has invalid quantity, price or tax.",
      );
      continue;
    }
    if (!line.purchaseOrderItemId) {
      add(
        "invoice",
        "UNLINKED_PURCHASE_ORDER_LINE",
        line.description + ": invoice line is not linked to a purchase-order line.",
      );
      continue;
    }
    const orderLine = orderById.get(line.purchaseOrderItemId);
    if (!orderLine) {
      add(
        "invoice",
        "FOREIGN_PURCHASE_ORDER_LINE",
        line.description + ": referenced purchase-order line is not part of this order.",
      );
      continue;
    }
    if (line.receiptItemId) {
      const receiptLine = receiptById.get(line.receiptItemId);
      if (!receiptLine || receiptLine.purchaseOrderItemId !== line.purchaseOrderItemId) {
        add(
          "invoice",
          "INVALID_RECEIPT_LINK",
          line.description +
            ": receipt line is not posted or does not belong to the referenced purchase-order line.",
        );
        continue;
      }
    }
    const accepted = acceptedByOrderLine.get(line.purchaseOrderItemId) ?? 0;
    if (accepted <= EPSILON) {
      pendingOrderLineIds.add(line.purchaseOrderItemId);
    }
    const invoiced = (invoicedByOrderLine.get(line.purchaseOrderItemId) ?? 0) + line.quantity;
    invoicedByOrderLine.set(line.purchaseOrderItemId, invoiced);
    if (
      Math.abs(line.unitPrice - orderLine.unitPrice) >
      Math.max(Math.abs(orderLine.unitPrice), 1) * 0.01 + 0.0001
    ) {
      add(
        "price",
        "INVOICED_PRICE_DIFFERS",
        line.description + ": invoiced unit price differs from the purchase-order price.",
        orderLine.unitPrice,
        line.unitPrice,
      );
    }
  }

  for (const [orderLineId, invoicedQuantity] of invoicedByOrderLine) {
    const acceptedQuantity = acceptedByOrderLine.get(orderLineId) ?? 0;
    if (acceptedQuantity <= EPSILON) continue;
    const previouslyInvoiced = evidence.previouslyInvoicedQuantities?.[orderLineId] ?? 0;
    if (!valid(previouslyInvoiced)) {
      add(
        "invoice",
        "INVALID_PRIOR_INVOICE_QUANTITY",
        "Prior invoice evidence contains an invalid quantity.",
      );
      continue;
    }
    const cumulativeInvoicedQuantity = previouslyInvoiced + invoicedQuantity;
    if (cumulativeInvoicedQuantity - acceptedQuantity > EPSILON) {
      add(
        "quantity",
        "INVOICED_ABOVE_ACCEPTED",
        "Purchase-order line " +
          orderLineId +
          ": invoiced quantity exceeds posted accepted quantity.",
        acceptedQuantity,
        cumulativeInvoicedQuantity,
      );
    } else if (cumulativeInvoicedQuantity + EPSILON < acceptedQuantity) {
      partiallyMatchedLineCount++;
    } else {
      acceptedLineCount++;
    }
  }
  pendingLineCount += pendingOrderLineIds.size;

  const hasMatchedEvidence = acceptedLineCount > 0 || partiallyMatchedLineCount > 0;
  const hasOutstandingEvidence =
    pendingLineCount > 0 || partiallyMatchedLineCount > 0;
  const matchStatus: InvoiceMatchStatus = dimensions.length
    ? "mismatched"
    : !hasMatchedEvidence
      ? "unmatched"
      : hasOutstandingEvidence
        ? "partially_matched"
        : "matched";
  return {
    matchStatus,
    dimensions,
    netSubtotal: computedNet,
    taxTotal: computedTax,
    grossTotal: computedGross,
    acceptedLineCount,
    partiallyMatchedLineCount,
    pendingLineCount,
  };
}
