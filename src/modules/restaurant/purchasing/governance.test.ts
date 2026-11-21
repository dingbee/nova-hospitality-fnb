import { describe, expect, it } from "vitest";
import {
  assertCurrency,
  priceOrderLines,
  purchaseOrderCommitmentIssues,
  roundMoney,
  type PurchaseOrderCommitmentSnapshot,
} from "./governance";
import { assertPurchaseOrderReceivable, PO_RECEIVABLE_STATUSES } from "./state-machine";

describe("roundMoney matches PostgreSQL round(numeric, 2)", () => {
  it.each([
    [3 * 333.335, 1000.01],
    [1.005, 1.01],
    [1.5 * 1000.1, 1500.15],
    [0.1 + 0.2, 0.3],
    [2.675, 2.68],
    [10, 10],
  ])("%s → %s", (input, expected) => {
    expect(roundMoney(input)).toBe(expected);
  });
});

describe("priceOrderLines", () => {
  it("computes line totals and the subtotal server-side", () => {
    const { lines, subtotal } = priceOrderLines([
      { description: "A", quantity: 3, unitPrice: 333.335 },
      { description: "B", quantity: 1.5, unitPrice: 1000.1 },
    ]);
    expect(lines.map((l) => l.lineTotal)).toEqual([1000.01, 1500.15]);
    expect(subtotal).toBe(2500.16);
  });

  it("refuses a zero price without an exception reason", () => {
    expect(() => priceOrderLines([{ description: "A", quantity: 1, unitPrice: 0 }])).toThrow(
      /PO_PRICE_REQUIRED/,
    );
    expect(() =>
      priceOrderLines([
        { description: "A", quantity: 1, unitPrice: 0, priceExceptionReason: "short" },
      ]),
    ).toThrow(/PO_PRICE_EXCEPTION_REASON_REQUIRED/);
  });

  it("accepts an explicit zero-price exception and drops reasons on priced lines", () => {
    const { lines } = priceOrderLines([
      {
        description: "Sample",
        quantity: 1,
        unitPrice: 0,
        priceExceptionReason: "Supplier tasting sample",
      },
      {
        description: "Priced",
        quantity: 1,
        unitPrice: 5,
        priceExceptionReason: "not an exception",
      },
    ]);
    expect(lines[0]!.priceExceptionReason).toBe("Supplier tasting sample");
    expect(lines[1]!.priceExceptionReason).toBeNull();
  });

  it.each([
    [{ quantity: 0, unitPrice: 1 }],
    [{ quantity: -1, unitPrice: 1 }],
    [{ quantity: 1, unitPrice: -1 }],
    [{ quantity: Number.NaN, unitPrice: 1 }],
    [{ quantity: 1, unitPrice: Number.POSITIVE_INFINITY }],
  ])("refuses invalid numbers %o", (line) => {
    expect(() => priceOrderLines([{ description: "X", ...line }])).toThrow();
  });
});

describe("assertCurrency", () => {
  it("normalises and validates ISO codes", () => {
    expect(assertCurrency("tzs")).toBe("TZS");
    expect(() => assertCurrency("TZ")).toThrow(/PO_CURRENCY_INVALID/);
    expect(() => assertCurrency("T1S")).toThrow(/PO_CURRENCY_INVALID/);
  });
});

describe("purchaseOrderCommitmentIssues", () => {
  const ok: PurchaseOrderCommitmentSnapshot = {
    supplierId: "s",
    supplierStatus: "active",
    propertyId: null,
    locationId: "hq",
    subtotal: 125000,
    taxTotal: 0,
    discountTotal: 0,
    total: 125000,
    lines: [
      {
        description: "Bitters",
        quantity: 10,
        unitPrice: 12500,
        lineTotal: 125000,
        priceExceptionReason: null,
        priceExceptionAuthorisedBy: null,
      },
    ],
  };

  it("passes a valid order", () => {
    expect(purchaseOrderCommitmentIssues(ok)).toEqual([]);
  });

  it("reports every governance failure of an unassigned, inactive-supplier, zero-price order", () => {
    const issues = purchaseOrderCommitmentIssues({
      ...ok,
      supplierStatus: "inactive",
      locationId: null,
      subtotal: 0,
      total: 0,
      lines: [{ ...ok.lines[0]!, unitPrice: 0, lineTotal: 0 }],
    });
    expect(issues.join(" ")).toMatch(/PO_DESTINATION_UNRESOLVED/);
    expect(issues.join(" ")).toMatch(/PO_SUPPLIER_INACTIVE/);
    expect(issues.join(" ")).toMatch(/PO_PRICE_REQUIRED/);
  });

  it("detects unreconciled totals", () => {
    expect(purchaseOrderCommitmentIssues({ ...ok, total: 1 }).join(" ")).toMatch(
      /PO_TOTALS_UNRECONCILED/,
    );
  });
});

describe("receiving requires an approved order", () => {
  it("only approved and partially received orders are receivable", () => {
    expect(PO_RECEIVABLE_STATUSES).toEqual(["approved", "partially_received"]);
    expect(() => assertPurchaseOrderReceivable("submitted")).toThrow(/not been approved/);
    expect(() => assertPurchaseOrderReceivable("draft")).toThrow();
    expect(() => assertPurchaseOrderReceivable("approved")).not.toThrow();
  });
});
