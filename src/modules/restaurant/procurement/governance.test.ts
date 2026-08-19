/**
 * UAT-2 procurement governance tests.
 *
 * These assert the invariants that must hold whichever screen or RPC the
 * caller used: there is one authoritative purchase-order state machine, the
 * fulfilment states are evidence-derived rather than user-asserted, and a
 * terminal order can never be reopened by a status write.
 */
import { describe, expect, it } from "vitest";
import {
  assertPurchaseOrderTransition,
  canTransitionPurchaseOrder,
  isTerminalPurchaseOrderStatus,
  PO_MANUAL_STATUSES,
} from "../purchasing/state-machine";
import { createPurchaseOrderSchema, transitionPurchaseOrderSchema } from "../core/contracts";
import { createReceiptSchema } from "./contracts";

describe("purchase order state machine", () => {
  it("permits the governed forward path", () => {
    expect(canTransitionPurchaseOrder("draft", "submitted")).toBe(true);
    expect(canTransitionPurchaseOrder("submitted", "approved")).toBe(true);
    expect(canTransitionPurchaseOrder("approved", "partially_received")).toBe(true);
    expect(canTransitionPurchaseOrder("partially_received", "received")).toBe(true);
  });

  it("refuses the invalid transitions named in UAT-2", () => {
    expect(() => assertPurchaseOrderTransition("draft", "received")).toThrow();
    expect(() => assertPurchaseOrderTransition("cancelled", "received")).toThrow();
    expect(() => assertPurchaseOrderTransition("received", "approved")).toThrow();
    expect(() => assertPurchaseOrderTransition("received", "cancelled")).toThrow();
  });

  it("treats received and cancelled as terminal", () => {
    expect(isTerminalPurchaseOrderStatus("received")).toBe(true);
    expect(isTerminalPurchaseOrderStatus("cancelled")).toBe(true);
    expect(isTerminalPurchaseOrderStatus("approved")).toBe(false);
  });

  it("reserves fulfilment states for the receiving service", () => {
    expect(() => assertPurchaseOrderTransition("approved", "received")).toThrow(/goods receiving/);
    expect(() =>
      assertPurchaseOrderTransition("approved", "received", { serviceOwned: true }),
    ).not.toThrow();
    expect(PO_MANUAL_STATUSES).toEqual(["submitted", "approved", "cancelled"]);
  });
});

describe("no generic status escape hatch", () => {
  it("rejects fulfilment statuses at the transition boundary", () => {
    const base = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      id: "22222222-2222-2222-2222-222222222222",
    };
    expect(transitionPurchaseOrderSchema.safeParse({ ...base, status: "received" }).success).toBe(false);
    expect(transitionPurchaseOrderSchema.safeParse({ ...base, status: "partially_received" }).success).toBe(
      false,
    );
    expect(transitionPurchaseOrderSchema.safeParse({ ...base, status: "draft" }).success).toBe(false);
    expect(transitionPurchaseOrderSchema.safeParse({ ...base, status: "approved" }).success).toBe(true);
  });
});

describe("direct purchase order governance", () => {
  const base = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    supplierId: "33333333-3333-3333-3333-333333333333",
    currency: "TZS",
    lines: [{ description: "Gin", quantity: 6, unitPrice: 20000 }],
  };

  it("refuses a direct order with no reason for bypassing requisition", () => {
    expect(createPurchaseOrderSchema.safeParse(base).success).toBe(false);
    expect(createPurchaseOrderSchema.safeParse({ ...base, directReason: "urgent" }).success).toBe(false);
  });

  it("accepts a direct order with an explicit authorised reason", () => {
    expect(
      createPurchaseOrderSchema.safeParse({
        ...base,
        directReason: "Emergency bar restock authorised by the general manager.",
      }).success,
    ).toBe(true);
  });
});

describe("over-receipt authorisation", () => {
  it("carries an optional but validated authorisation reason", () => {
    const base = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      lines: [
        {
          description: "Gin",
          receivedQuantity: 120,
          acceptedQuantity: 120,
          unitCost: 20000,
        },
      ],
    };
    expect(createReceiptSchema.safeParse(base).success).toBe(true);
    expect(createReceiptSchema.safeParse({ ...base, overReceiptReason: "short" }).success).toBe(false);
    expect(
      createReceiptSchema.safeParse({
        ...base,
        overReceiptReason: "Supplier delivered a full pallet, accepted by the GM.",
      }).success,
    ).toBe(true);
  });
});
