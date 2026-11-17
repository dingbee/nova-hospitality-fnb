import { describe, expect, it } from "vitest";
import {
  PO_DELIVERY_FAILURE_MESSAGES,
  buildPurchaseOrderMessage,
  requestPoDeliverySchema,
} from "./poDelivery.types";

describe("purchase order message", () => {
  it("carries the document number and total, never recomputing money", () => {
    const msg = buildPurchaseOrderMessage({
      documentNumber: "PO-2026-000001",
      supplierName: "ABC Foods",
      total: "TZS 45,000.00",
    });
    expect(msg).toContain("PO-2026-000001");
    expect(msg).toContain("ABC Foods");
    expect(msg).toContain("TZS 45,000.00");
  });

  it("includes the requested delivery date only when one is given", () => {
    const withDate = buildPurchaseOrderMessage({
      documentNumber: "PO-1",
      total: "TZS 1.00",
      expectedAt: "2026-09-01",
    });
    const withoutDate = buildPurchaseOrderMessage({ documentNumber: "PO-1", total: "TZS 1.00" });
    expect(withDate).toContain("2026-09-01");
    expect(withoutDate).not.toContain("Requested delivery");
  });
});

describe("request delivery contract", () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const purchaseOrderId = "22222222-2222-4222-8222-222222222222";

  it("requires an idempotency key so a double-click cannot send twice", () => {
    expect(() =>
      requestPoDeliverySchema.parse({ tenantId, purchaseOrderId, method: "email" }),
    ).toThrow();
    const parsed = requestPoDeliverySchema.parse({
      tenantId,
      purchaseOrderId,
      method: "email",
      idempotencyKey: "po-email-1712-abc",
    });
    expect(parsed.idempotencyKey).toBe("po-email-1712-abc");
  });

  it("always scopes a request to one tenant, blocking cross-tenant guesses", () => {
    expect(() =>
      requestPoDeliverySchema.parse({
        purchaseOrderId,
        method: "email",
        idempotencyKey: "k-123456",
      }),
    ).toThrow();
    expect(() =>
      requestPoDeliverySchema.parse({
        tenantId: "not-a-uuid",
        purchaseOrderId,
        method: "email",
        idempotencyKey: "k-123456",
      }),
    ).toThrow();
  });

  it("only accepts email and whatsapp — no send option without a functioning provider behind it", () => {
    for (const method of ["email", "whatsapp"]) {
      expect(
        requestPoDeliverySchema.parse({
          tenantId,
          purchaseOrderId,
          method,
          idempotencyKey: "k-123456",
        }).method,
      ).toBe(method);
    }
    expect(() =>
      requestPoDeliverySchema.parse({
        tenantId,
        purchaseOrderId,
        method: "sms",
        idempotencyKey: "k-123456",
      }),
    ).toThrow();
  });
});

describe("operator-facing failures", () => {
  it("never falls back to a generic message", () => {
    for (const message of Object.values(PO_DELIVERY_FAILURE_MESSAGES)) {
      expect(message.length).toBeGreaterThan(15);
      expect(message.toLowerCase()).not.toContain("something went wrong");
    }
  });
});
