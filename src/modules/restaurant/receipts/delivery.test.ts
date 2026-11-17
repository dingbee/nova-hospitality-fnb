import { describe, expect, it } from "vitest";
import {
  DELIVERY_FAILURE_MESSAGES,
  buildReceiptMessage,
  isValidEmail,
  normalizeEmail,
  normalizePhone,
  requestDeliverySchema,
  whatsAppShareUrl,
} from "./delivery.types";

describe("email validation", () => {
  it("accepts real addresses and normalizes them", () => {
    expect(isValidEmail("Guest@Example.com")).toBe(true);
    expect(normalizeEmail(" Guest@Example.com ")).toBe("guest@example.com");
  });
  it("rejects malformed addresses", () => {
    for (const bad of ["", "guest", "guest@", "@example.com", "a b@c.com", "guest@example"]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
});

describe("phone normalization", () => {
  it("normalizes Tanzanian local formats to E.164", () => {
    expect(normalizePhone("0712 345 678")).toBe("+255712345678");
    expect(normalizePhone("712345678")).toBe("+255712345678");
    expect(normalizePhone("+255 712-345-678")).toBe("+255712345678");
    expect(normalizePhone("00255712345678")).toBe("+255712345678");
  });
  it("refuses numbers it cannot trust", () => {
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("+1234567890123456")).toBeNull();
  });
});

describe("share message", () => {
  it("carries the receipt number and secure link, never totals recomputed", () => {
    const msg = buildReceiptMessage({
      receiptNumber: "RCP-1",
      total: "TZS 10,000.00",
      link: "https://x.test/receipt/abc",
    });
    expect(msg).toContain("RCP-1");
    expect(msg).toContain("TZS 10,000.00");
    expect(msg).toContain("https://x.test/receipt/abc");
  });
  it("builds a wa.me url with and without a number", () => {
    expect(whatsAppShareUrl("+255712345678", "hi")).toBe("https://wa.me/255712345678?text=hi");
    expect(whatsAppShareUrl(null, "hi")).toBe("https://wa.me/?text=hi");
  });
});

describe("delivery request contract", () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const receiptId = "22222222-2222-4222-8222-222222222222";

  it("requires an idempotency key so a double-click cannot send twice", () => {
    expect(() =>
      requestDeliverySchema.parse({ tenantId, receiptId, method: "email", recipient: "a@b.com" }),
    ).toThrow();
    const parsed = requestDeliverySchema.parse({
      tenantId,
      receiptId,
      method: "email",
      recipient: "a@b.com",
      idempotencyKey: "email-1712-abc",
    });
    expect(parsed.idempotencyKey).toBe("email-1712-abc");
  });

  it("always scopes a request to one tenant, blocking cross-tenant guesses", () => {
    expect(() => requestDeliverySchema.parse({ receiptId, method: "print", idempotencyKey: "print-1" })).toThrow();
    expect(() =>
      requestDeliverySchema.parse({ tenantId: "not-a-uuid", receiptId, method: "print", idempotencyKey: "print-1" }),
    ).toThrow();
  });

  it("only accepts the four supported methods", () => {
    for (const method of ["print", "email", "whatsapp", "secure_link"]) {
      expect(
        requestDeliverySchema.parse({ tenantId, receiptId, method, idempotencyKey: "k-123456" }).method,
      ).toBe(method);
    }
    expect(() => requestDeliverySchema.parse({ tenantId, receiptId, method: "sms", idempotencyKey: "k-123456" })).toThrow();
  });
});

describe("operator-facing failures", () => {
  it("never falls back to a generic message", () => {
    for (const message of Object.values(DELIVERY_FAILURE_MESSAGES)) {
      expect(message.length).toBeGreaterThan(20);
      expect(message.toLowerCase()).not.toContain("something went wrong");
    }
  });
});