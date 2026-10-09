import { describe, expect, it } from "vitest";
import { serviceRecoverySchema } from "./service-recovery.contracts";

const valid = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  orderId: "22222222-2222-4222-8222-222222222222",
  originalOrderItemId: "33333333-3333-4333-8333-333333333333",
  clientRequestId: "recovery-request-001",
  complaintCategory: "quality",
  complaint: "Meal arrived cold",
  resolution: "pending",
  resolutionReason: "Guest complaint received; supervisor review required",
  stockDisposition: "preserve_consumption",
};

describe("service recovery contract", () => {
  it("accepts a tenant-scoped complaint with an explicit pending resolution", () => {
    expect(serviceRecoverySchema.parse(valid)).toMatchObject({
      complaintCategory: "quality",
      resolution: "pending",
      stockDisposition: "preserve_consumption",
    });
  });

  it("rejects an unknown complaint category", () => {
    expect(() => serviceRecoverySchema.parse({ ...valid, complaintCategory: "bad_mood" })).toThrow();
  });

  it("requires an idempotency key", () => {
    const { clientRequestId: _ignored, ...withoutKey } = valid;
    expect(() => serviceRecoverySchema.parse(withoutKey)).toThrow();
  });

  it("requires a meaningful complaint and resolution reason", () => {
    expect(() => serviceRecoverySchema.parse({ ...valid, complaint: "ok" })).toThrow();
    expect(() => serviceRecoverySchema.parse({ ...valid, resolutionReason: "no" })).toThrow();
  });
});
