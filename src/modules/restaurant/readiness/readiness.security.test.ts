/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P13 readiness engine — security boundary tests.
 *
 * The engine must never compute or leak a readiness answer for a tenant the
 * caller isn't a member of, and must never let a non-owner/GM confirm
 * go-live. It reuses `assertTenantRead`/`assertCapability` exactly like
 * every other module in this codebase — these tests prove it actually calls
 * them, on every path, rather than bypassing them for its own reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const assertTenantReadMock = vi.fn();
const assertCapabilityMock = vi.fn();
const getTenantScopeMock = vi.fn();
vi.mock("../core/access.server", () => ({
  assertTenantRead: (...args: unknown[]) => assertTenantReadMock(...args),
  assertCapability: (...args: unknown[]) => assertCapabilityMock(...args),
  getTenantScope: (...args: unknown[]) => getTenantScopeMock(...args),
}));

const pricingReadinessMock = vi.fn();
vi.mock("../pricing/readiness.server", () => ({
  pricingReadiness: (...args: unknown[]) => pricingReadinessMock(...args),
}));

const { computeReadiness, confirmGoLive } = await import("./readiness.server");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const STRANGER = "99999999-9999-9999-9999-999999999999";

function makeFakeSb() {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    is: () => chain,
    gte: () => chain,
    limit: () => chain,
    order: () => chain,
    single: async () => ({
      data: { id: TENANT_A, name: "Kilimanjaro Grill", settings: {} },
      error: null,
    }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: any) => resolve({ data: [], error: null }),
    update: () => ({ eq: async () => ({ data: null, error: null }) }),
  };
  return { from: () => chain };
}

beforeEach(() => {
  assertTenantReadMock.mockReset();
  assertCapabilityMock.mockReset();
  getTenantScopeMock.mockReset().mockResolvedValue({ platformAdmin: false, grants: [] });
  pricingReadinessMock.mockReset().mockResolvedValue({
    generatedAt: new Date().toISOString(),
    channel: "dine_in",
    total: 0,
    ready: 0,
    blocked: 0,
    divergent: 0,
    rulesInForce: {
      prices: 0,
      priceLists: 0,
      taxes: 0,
      serviceCharges: 0,
      promotions: 0,
      roundingRules: 0,
    },
    rows: [],
  });
});

describe("computeReadiness — tenant isolation", () => {
  it("never computes a readiness report for a caller who isn't a member of the tenant", async () => {
    assertTenantReadMock.mockRejectedValue(
      new Error("Forbidden — you do not belong to this restaurant tenant."),
    );
    const sb = makeFakeSb();
    await expect(computeReadiness(sb, STRANGER, TENANT_A)).rejects.toThrow(/forbidden/i);
  });

  it("asserts tenant read using the exact tenantId the caller supplied — no substitution, no default", async () => {
    assertTenantReadMock.mockResolvedValue(undefined);
    const sb = makeFakeSb();
    await computeReadiness(sb, STRANGER, TENANT_A);
    expect(assertTenantReadMock).toHaveBeenCalledWith(sb, STRANGER, TENANT_A);
  });

  it("passes the caller's own userId — never a client-supplied identity — into the pricing sub-engine", async () => {
    assertTenantReadMock.mockResolvedValue(undefined);
    const sb = makeFakeSb();
    await computeReadiness(sb, STRANGER, TENANT_A);
    expect(pricingReadinessMock).toHaveBeenCalledWith(sb, STRANGER, { tenantId: TENANT_A });
  });
});

describe("confirmGoLive — authorization gate", () => {
  it("rejects a caller without tenant.manage before ever computing readiness or writing anything", async () => {
    assertCapabilityMock.mockRejectedValue(
      new Error("Forbidden — insufficient role for capability tenant.manage."),
    );
    const sb = makeFakeSb();
    await expect(confirmGoLive(sb, STRANGER, TENANT_A)).rejects.toThrow(/forbidden/i);
    // computeReadiness (and therefore every domain read) must never run for an unauthorized caller.
    expect(assertTenantReadMock).not.toHaveBeenCalled();
  });

  it("checks the capability against the specific tenantId supplied, not a cached or default scope", async () => {
    assertCapabilityMock.mockResolvedValue(undefined);
    assertTenantReadMock.mockResolvedValue(undefined);
    const sb = makeFakeSb();
    await confirmGoLive(sb, STRANGER, TENANT_A).catch(() => {});
    expect(assertCapabilityMock).toHaveBeenCalledWith(sb, STRANGER, TENANT_A, "tenant.manage");
  });
});
