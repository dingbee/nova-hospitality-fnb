/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase client is untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { assertMayApprove } from "./approvals.server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const APPROVER = "22222222-2222-4222-8222-222222222222";
const REQUESTER = "33333333-3333-4333-8333-333333333333";
const PROPERTY = "44444444-4444-4444-8444-444444444444";

function fake(grants: Array<{ role: string; property_id: string | null }>) {
  const q: any = {
    select: () => q,
    eq: () => q,
    order: () => q,
    then: (resolve: any) => resolve({ data: [], error: null }),
  };
  return {
    rpc: async () => ({ data: false, error: null }),
    from: (table: string) =>
      table === "restaurant_members"
        ? {
            select: () => ({
              eq: () => ({ eq: async () => ({ data: grants, error: null }) }),
            }),
          }
        : q,
  } as any;
}

const scope = (propertyId: string | null) => ({
  tenantId: TENANT,
  documentType: "purchase_order" as const,
  amount: 125000,
  requesterId: REQUESTER,
  propertyId,
  locationId: null,
});

describe("approval of property-less (central store) documents", () => {
  it("refuses a property-scoped approver — NULL property is never a tenant-wide bypass", async () => {
    await expect(
      assertMayApprove(
        fake([{ role: "restaurant_manager", property_id: PROPERTY }]),
        APPROVER,
        scope(null),
      ),
    ).rejects.toThrow(/tenant-wide approver/);
  });

  it("allows a tenant-wide approver", async () => {
    await expect(
      assertMayApprove(
        fake([{ role: "general_manager", property_id: null }]),
        APPROVER,
        scope(null),
      ),
    ).resolves.toMatchObject({ source: "default" });
  });

  it("keeps property-level approval working for the property's own approver", async () => {
    await expect(
      assertMayApprove(
        fake([{ role: "restaurant_manager", property_id: PROPERTY }]),
        APPROVER,
        scope(PROPERTY),
      ),
    ).resolves.toBeTruthy();
  });
});
