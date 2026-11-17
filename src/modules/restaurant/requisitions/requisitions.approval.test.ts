import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => mocks.assertCapability(...args),
  assertTenantRead: vi.fn(),
}));

vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn().mockResolvedValue(undefined),
}));

const { approveRequisition } = await import("./requisitions.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const MAKER = "22222222-2222-2222-2222-222222222222";
const PROPERTY = "33333333-3333-3333-3333-333333333333";
const SOURCE = "44444444-4444-4444-4444-444444444444";
const DESTINATION = "55555555-5555-5555-5555-555555555555";
const REQUISITION = "66666666-6666-6666-6666-666666666666";

function makeSupabase() {
  const requisition = {
    id: REQUISITION,
    tenant_id: TENANT,
    property_id: PROPERTY,
    source_location_id: SOURCE,
    destination_location_id: DESTINATION,
    created_by: MAKER,
    status: "submitted",
    reference: "REQ-001",
  };
  const writes: unknown[] = [];
  type ListResult = { data: unknown[]; error: null };
  type Query = PromiseLike<ListResult> & {
    select: (...args: unknown[]) => Query;
    eq: (...args: unknown[]) => Query;
    order: (...args: unknown[]) => Query;
    update: (value: unknown) => Query;
    single: () => Promise<{ data: typeof requisition | null; error: null }>;
  };
  function builder(table: string): Query {
    const api: Query = {
      select: () => api,
      eq: () => api,
      order: () => api,
      update: (value) => {
        writes.push(value);
        return api;
      },
      single: async () => ({
        data: table === "restaurant_requisitions" ? requisition : null,
        error: null,
      }),
      then: (onfulfilled, onrejected) =>
        Promise.resolve({ data: [], error: null }).then(onfulfilled, onrejected),
    };
    return api;
  }
  return { sb: { from: builder } as unknown as Parameters<typeof approveRequisition>[0], writes };
}

describe("requisition maker-checker and endpoint scope", () => {
  it("denies the requisition creator from approving their own request", async () => {
    const fake = makeSupabase();
    await expect(
      approveRequisition(fake.sb, MAKER, {
        tenantId: TENANT,
        requisitionId: REQUISITION,
        lines: [],
      } as Parameters<typeof approveRequisition>[2]),
    ).rejects.toThrow(/Separation of duties/);

    expect(mocks.assertCapability).toHaveBeenNthCalledWith(
      1,
      fake.sb,
      MAKER,
      TENANT,
      "requisition.approve",
      { propertyId: PROPERTY, locationId: SOURCE },
    );
    expect(mocks.assertCapability).toHaveBeenNthCalledWith(
      2,
      fake.sb,
      MAKER,
      TENANT,
      "requisition.approve",
      { locationId: DESTINATION },
    );
    expect(fake.writes).toHaveLength(0);
  });
});
