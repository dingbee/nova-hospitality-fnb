import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn().mockResolvedValue(undefined),
  isPlatformAdmin: vi.fn().mockResolvedValue(true),
  assertMayApprove: vi.fn().mockRejectedValue(new Error("Separation of duties — a requester cannot approve their own request.")),
  emitRestaurantEvent: vi.fn().mockResolvedValue(undefined),
  recordProcurementAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => mocks.assertCapability(...args),
  isPlatformAdmin: (...args: unknown[]) => mocks.isPlatformAdmin(...args),
}));

vi.mock("../procurement/approvals.server", () => ({
  assertMayApprove: (...args: unknown[]) => mocks.assertMayApprove(...args),
}));

vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: (...args: unknown[]) => mocks.emitRestaurantEvent(...args),
}));

vi.mock("../procurement/audit.server", () => ({
  insertWithUniqueDocumentNumber: vi.fn(),
  recordProcurementAudit: (...args: unknown[]) => mocks.recordProcurementAudit(...args),
}));

const { transitionPurchaseOrder } = await import("./purchasing.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PROPERTY = "33333333-3333-3333-3333-333333333333";
const ORDER = "44444444-4444-4444-4444-444444444444";

function makeSupabase() {
  const current = {
    id: ORDER,
    reference: "PO-001",
    document_number: "PO-2026-00001",
    status: "submitted",
    total: 1000,
    location_id: null,
    property_id: PROPERTY,
    correlation_id: null,
    created_by: USER,
    buyer_id: USER,
  };
  let operation = "select";
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    update: () => {
      operation = "update";
      return builder;
    },
    single: async () => ({
      data: operation === "select" ? current : { ...current, status: "approved" },
      error: null,
    }),
  };
  return {
    from: () => builder,
    rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
  };
}

describe("purchase-order maker-checker", () => {
  it("denies a buyer's self-approval even when the caller is a platform administrator", async () => {
    const sb = makeSupabase();
    await expect(
      transitionPurchaseOrder(sb, USER, {
        tenantId: TENANT,
        id: ORDER,
        status: "approved",
      } as any),
    ).rejects.toThrow(/Separation of duties/);

    expect(mocks.assertCapability).toHaveBeenCalledWith(
      sb,
      USER,
      TENANT,
      "purchasing.approve",
      { propertyId: PROPERTY },
    );
    expect(mocks.assertMayApprove).toHaveBeenCalledWith(sb, USER, {
      tenantId: TENANT,
      documentType: "purchase_order",
      amount: 1000,
      requesterId: USER,
      propertyId: PROPERTY,
      locationId: null,
    });
    expect(mocks.isPlatformAdmin).not.toHaveBeenCalled();
    expect(sb.rpc).not.toHaveBeenCalled();
  });
});
