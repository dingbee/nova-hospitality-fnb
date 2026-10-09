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


import { serviceRecoveryResolutionSchema } from "./service-recovery.contracts";

describe("service recovery resolution contract", () => {
  const base = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    caseId: "22222222-2222-4222-8222-222222222222",
    resolution: "replace",
    reason: "Supervisor approved replacement",
  };
  it("accepts a supervisor resolution with an explicit reason", () => {
    expect(serviceRecoveryResolutionSchema.parse(base)).toMatchObject({ resolution: "replace", reason: base.reason });
  });
  it("requires a payment and positive amount for refund workflows at the service boundary", () => {
    expect(serviceRecoveryResolutionSchema.parse({ ...base, resolution: "refund", paymentId: "33333333-3333-4333-8333-333333333333", amount: 10 }).amount).toBe(10);
    expect(() => serviceRecoveryResolutionSchema.parse({ ...base, resolution: "refund", amount: 0 })).toThrow();
  });
  it("rejects unsupported outcomes and empty resolution reasons", () => {
    expect(() => serviceRecoveryResolutionSchema.parse({ ...base, resolution: "pending" })).toThrow();
    expect(() => serviceRecoveryResolutionSchema.parse({ ...base, reason: "  " })).toThrow();
  });
});
