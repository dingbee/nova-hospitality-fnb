import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn().mockResolvedValue(undefined),
  recordProcurementAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => mocks.assertCapability(...args),
  assertTenantRead: vi.fn(),
}));

vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./audit.server", () => ({
  recordProcurementAudit: (...args: unknown[]) => mocks.recordProcurementAudit(...args),
}));

const { resolveVariance } = await import("./variances.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const MAKER = "22222222-2222-2222-2222-222222222222";
const CHECKER = "33333333-3333-3333-3333-333333333333";
const PROPERTY = "44444444-4444-4444-4444-444444444444";
const LOCATION = "55555555-5555-5555-5555-555555555555";
const VARIANCE = "66666666-6666-6666-6666-666666666666";

function makeSupabase() {
  const before = {
    id: VARIANCE,
    status: "open",
    label: "Quantity variance",
    created_by: MAKER,
    property_id: PROPERTY,
    location_id: LOCATION,
  };
  const writes: unknown[] = [];
  let operation = "select";
  let patch: { status: string } | null = null;
  type Query = {
    select: (...args: unknown[]) => Query;
    eq: (...args: unknown[]) => Query;
    update: (value: { status: string }) => Query;
    single: () => Promise<{ data: typeof before | { id: string; status: string }; error: null }>;
  };
  const builder: Query = {
    select: () => builder,
    eq: () => builder,
    update: (value: { status: string }) => {
      operation = "update";
      patch = value;
      writes.push(value);
      return builder;
    },
    single: async () => ({
      data: operation === "select" ? before : { id: VARIANCE, status: patch?.status ?? "open" },
      error: null,
    }),
  };
  return { sb: { from: () => builder } as unknown as Parameters<typeof resolveVariance>[0], writes };
}

describe("procurement variance maker-checker", () => {
  it("denies the user who raised a variance from resolving it", async () => {
    const fake = makeSupabase();
    await expect(
      resolveVariance(fake.sb, MAKER, {
        tenantId: TENANT,
        id: VARIANCE,
        status: "resolved",
        notes: "Reviewed",
      } as Parameters<typeof resolveVariance>[2]),
    ).rejects.toThrow(/Separation of duties/);

    expect(mocks.assertCapability).toHaveBeenCalledWith(fake.sb, MAKER, TENANT, "variance.manage", {
      propertyId: PROPERTY,
      locationId: LOCATION,
    });
    expect(fake.writes).toHaveLength(0);
  });

  it("allows an independent authorized resolver and records the decision", async () => {
    const fake = makeSupabase();
    await expect(
      resolveVariance(fake.sb, CHECKER, {
        tenantId: TENANT,
        id: VARIANCE,
        status: "resolved",
        notes: "Evidence reviewed and reconciled",
      } as Parameters<typeof resolveVariance>[2]),
    ).resolves.toMatchObject({ id: VARIANCE, status: "resolved" });

    expect(mocks.assertCapability).toHaveBeenCalledWith(
      fake.sb,
      CHECKER,
      TENANT,
      "variance.manage",
      { propertyId: PROPERTY, locationId: LOCATION },
    );
    expect(mocks.recordProcurementAudit).toHaveBeenCalledWith(
      fake.sb,
      CHECKER,
      expect.objectContaining({
        tenantId: TENANT,
        documentId: VARIANCE,
        previousState: "open",
        newState: "resolved",
        reason: "Evidence reviewed and reconciled",
      }),
    );
  });
});
