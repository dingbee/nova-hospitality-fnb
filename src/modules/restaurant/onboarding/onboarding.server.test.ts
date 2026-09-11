/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * P12 First-Run Experience — server module tests.
 *
 * bootstrapTenant is the one genuinely new authoritative write in this
 * codebase (see onboarding.server.ts's doc comment for why it must be a
 * SECURITY DEFINER RPC, not an ordinary insert); these tests exercise the
 * TypeScript wrapper's own logic (slug generation/retry, error surfacing)
 * against a fake `sb.rpc`. createFirstOutlet/setOperatingModel/
 * getOnboardingStatus are tested against fakes that mirror exactly what
 * upsertProperty/upsertLocation/assertCapability/assertTenantRead already
 * assume, since those are the real, already-tested authoritative functions
 * this module hands off to — not reimplemented here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertPropertyMock = vi.fn();
vi.mock("../masterdata/masterdata.server", () => ({
  upsertProperty: (...args: unknown[]) => upsertPropertyMock(...args),
}));

const upsertLocationMock = vi.fn();
vi.mock("../inventory/locations.server", () => ({
  upsertLocation: (...args: unknown[]) => upsertLocationMock(...args),
}));

const assertCapabilityMock = vi.fn();
const assertTenantReadMock = vi.fn();
vi.mock("../core/access.server", () => ({
  assertCapability: (...args: unknown[]) => assertCapabilityMock(...args),
  assertTenantRead: (...args: unknown[]) => assertTenantReadMock(...args),
}));

const emitRestaurantEventMock = vi.fn();
vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: (...args: unknown[]) => emitRestaurantEventMock(...args),
}));

const {
  bootstrapTenant,
  createFirstOutlet,
  setOperatingModel,
  getOnboardingStatus,
  recordOnboardingEvent,
} = await import("./onboarding.server");

const TENANT = "11111111-1111-1111-1111-111111111111";
const OWNER = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  upsertPropertyMock.mockReset();
  upsertLocationMock.mockReset();
  assertCapabilityMock.mockReset();
  assertCapabilityMock.mockResolvedValue(undefined);
  assertTenantReadMock.mockReset();
  assertTenantReadMock.mockResolvedValue(undefined);
  emitRestaurantEventMock.mockReset();
  emitRestaurantEventMock.mockResolvedValue({ delivered: true, duplicate: false });
});

describe("bootstrapTenant", () => {
  it("derives a slug from the business name and returns the RPC's tenant/member ids", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ tenant_id: TENANT, member_id: "member-1" }],
      error: null,
    });
    const sb = { rpc };
    const result = await bootstrapTenant(sb, OWNER, {
      name: "Kilimanjaro Grill",
      businessType: "restaurant",
      currency: "TZS",
      timezone: "Africa/Dar_es_Salaam",
    });
    expect(result).toEqual({ tenantId: TENANT, memberId: "member-1", slug: "kilimanjaro-grill" });
    expect(rpc).toHaveBeenCalledWith(
      "restaurant_bootstrap_tenant",
      expect.objectContaining({
        _name: "Kilimanjaro Grill",
        _slug: "kilimanjaro-grill",
        _business_type: "restaurant",
      }),
    );
  });

  it("retries with a suffixed slug when the name collides, never surfacing the collision to the caller", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: "that business name is already taken" },
      })
      .mockResolvedValueOnce({ data: [{ tenant_id: TENANT, member_id: "member-2" }], error: null });
    const sb = { rpc };
    const result = await bootstrapTenant(sb, OWNER, {
      name: "The Grill",
      businessType: "restaurant",
      currency: "TZS",
      timezone: "Africa/Dar_es_Salaam",
    });
    expect(result.tenantId).toBe(TENANT);
    expect(rpc).toHaveBeenCalledTimes(2);
    const secondCallSlug = rpc.mock.calls[1]![1]._slug as string;
    expect(secondCallSlug).not.toBe("the-grill");
    expect(secondCallSlug.startsWith("the-grill-")).toBe(true);
  });

  it("surfaces a genuine RPC error (not a slug collision) verbatim rather than retrying forever", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "business name is required" } });
    const sb = { rpc };
    await expect(
      bootstrapTenant(sb, OWNER, {
        name: "AB",
        businessType: "restaurant",
        currency: "TZS",
        timezone: "Africa/Dar_es_Salaam",
      }),
    ).rejects.toThrow(/business name is required/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("passes the country through to the RPC so P13's fiscalisation gate (which matches on the full country name) can see it (§3/§13 closure)", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [{ tenant_id: TENANT, member_id: "m" }], error: null });
    const sb = { rpc };
    await bootstrapTenant(sb, OWNER, {
      name: "Kilimanjaro Grill",
      businessType: "restaurant",
      country: "Tanzania",
      currency: "TZS",
      timezone: "Africa/Dar_es_Salaam",
    });
    expect(rpc).toHaveBeenCalledWith(
      "restaurant_bootstrap_tenant",
      expect.objectContaining({ _country: "Tanzania" }),
    );
  });

  it("never derives the owner from anything but the server-side session — no ownerId/userId field is ever sent to the RPC", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [{ tenant_id: TENANT, member_id: "m" }], error: null });
    const sb = { rpc };
    await bootstrapTenant(sb, OWNER, {
      name: "Test Diner",
      businessType: "restaurant",
      currency: "TZS",
      timezone: "Africa/Dar_es_Salaam",
    });
    const sentParams = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(sentParams)).not.toContain("_user_id");
    expect(Object.keys(sentParams)).not.toContain("_owner_id");
  });
});

describe("createFirstOutlet — single-outlet optimization (§12)", () => {
  it("creates exactly one property and one outlet from the two names the wizard collects", async () => {
    upsertPropertyMock.mockResolvedValue({
      id: "prop-1",
      name: "Main",
      slug: "main",
      status: "active",
    });
    upsertLocationMock.mockResolvedValue({ id: "loc-1", name: "Restaurant", code: null });
    const sb = {};
    const result = await createFirstOutlet(sb, OWNER, {
      tenantId: TENANT,
      propertyName: "Main",
      outletName: "Restaurant",
    });
    expect(result).toEqual({ propertyId: "prop-1", locationId: "loc-1" });
    expect(upsertPropertyMock).toHaveBeenCalledTimes(1);
    expect(upsertLocationMock).toHaveBeenCalledTimes(1);
    // The outlet must be created under the property that was just created,
    // never a stale/guessed property id.
    const locationArgs = upsertLocationMock.mock.calls[0]![2] as any;
    expect(locationArgs.propertyId).toBe("prop-1");
    expect(locationArgs.tenantId).toBe(TENANT);
  });

  it("§17 — passes the caller-supplied tenantId through unmodified to both authoritative writes, no substitution", async () => {
    upsertPropertyMock.mockResolvedValue({ id: "prop-1" });
    upsertLocationMock.mockResolvedValue({ id: "loc-1" });
    const sb = {};
    const otherTenant = "99999999-9999-9999-9999-999999999999";
    await createFirstOutlet(sb, OWNER, {
      tenantId: otherTenant,
      propertyName: "Main",
      outletName: "Restaurant",
    });
    expect(upsertPropertyMock.mock.calls[0]![2].tenantId).toBe(otherTenant);
    expect(upsertLocationMock.mock.calls[0]![2].tenantId).toBe(otherTenant);
  });

  it("§15/§27 — a genuine failure (e.g. an authorization rejection inside upsertProperty) propagates cleanly, leaves no partial outlet behind", async () => {
    upsertPropertyMock.mockRejectedValue(
      new Error("Forbidden — you do not belong to this restaurant tenant."),
    );
    const sb = {};
    await expect(
      createFirstOutlet(sb, OWNER, {
        tenantId: TENANT,
        propertyName: "Main",
        outletName: "Restaurant",
      }),
    ).rejects.toThrow(/Forbidden/);
    // The property write failed — the outlet write must never be attempted on top of it.
    expect(upsertLocationMock).not.toHaveBeenCalled();
  });
});

describe("setOperatingModel", () => {
  it("requires tenant.manage — the same capability every other tenant-settings write requires", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { settings: {} }, error: null }),
          }),
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({
                data: { id: TENANT, settings: { onboarding: { operatingMode: "table_service" } } },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };
    await setOperatingModel(sb, OWNER, {
      tenantId: TENANT,
      operatingMode: "table_service",
      serviceFeatures: ["kitchen"],
    });
    expect(assertCapabilityMock).toHaveBeenCalledWith(sb, OWNER, TENANT, "tenant.manage");
  });

  it("merges into settings.onboarding without touching sibling settings namespaces (settings.business, settings.serviceRequests)", async () => {
    const existingSettings = {
      business: { legalName: "Kilimanjaro Ltd" },
      serviceRequests: { cooldownSeconds: 60 },
    };
    let updatedSettings: any = null;
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { settings: existingSettings }, error: null }),
          }),
        }),
        update: (patch: any) => {
          updatedSettings = patch.settings;
          return {
            eq: () => ({
              select: () => ({
                single: async () => ({
                  data: { id: TENANT, settings: updatedSettings },
                  error: null,
                }),
              }),
            }),
          };
        },
      }),
    };
    await setOperatingModel(sb, OWNER, {
      tenantId: TENANT,
      operatingMode: "bar_service",
      serviceFeatures: ["bar", "takeaway"],
    });
    expect(updatedSettings.business).toEqual({ legalName: "Kilimanjaro Ltd" });
    expect(updatedSettings.serviceRequests).toEqual({ cooldownSeconds: 60 });
    expect(updatedSettings.onboarding).toEqual({
      operatingMode: "bar_service",
      serviceFeatures: ["bar", "takeaway"],
    });
  });
});

describe("getOnboardingStatus — derived from live rows, never a stored step (§15/§17/§19)", () => {
  function makeSb({
    properties = [],
    locations = [],
    settings = {},
  }: {
    properties?: unknown[];
    locations?: unknown[];
    settings?: Record<string, unknown>;
  }) {
    return {
      from: (table: string) => ({
        select: () => ({
          eq: (..._args: unknown[]) => {
            if (table === "restaurant_tenants") {
              return {
                single: async () => ({ data: { id: TENANT, name: "Test", settings }, error: null }),
              };
            }
            if (table === "restaurant_properties")
              return Promise.resolve({ data: properties, error: null });
            if (table === "restaurant_locations")
              return Promise.resolve({ data: locations, error: null });
            return Promise.resolve({ data: [], error: null });
          },
        }),
      }),
    };
  }

  it("stage=property, 0% when nothing has been created yet — the true zero state", async () => {
    const sb = makeSb({});
    const status = await getOnboardingStatus(sb, OWNER, TENANT);
    expect(status.stage).toBe("property");
    expect(status.percentComplete).toBe(0);
    expect(assertTenantReadMock).toHaveBeenCalledWith(sb, OWNER, TENANT);
  });

  it("stage=outlet once a property exists but no outlet does — resumable from wherever the user left off", async () => {
    const sb = makeSb({ properties: [{ id: "p1" }] });
    const status = await getOnboardingStatus(sb, OWNER, TENANT);
    expect(status.stage).toBe("outlet");
    expect(status.property.done).toBe(true);
    expect(status.outlet.done).toBe(false);
  });

  it("stage=operating_model once property+outlet exist but no operating mode is set", async () => {
    const sb = makeSb({ properties: [{ id: "p1" }], locations: [{ id: "l1" }] });
    const status = await getOnboardingStatus(sb, OWNER, TENANT);
    expect(status.stage).toBe("operating_model");
    expect(status.percentComplete).toBe(67);
  });

  it("stage=ready, 100% once property+outlet+operating model all exist — hands off to P13", async () => {
    const sb = makeSb({
      properties: [{ id: "p1" }],
      locations: [{ id: "l1" }],
      settings: { onboarding: { operatingMode: "table_service", serviceFeatures: ["kitchen"] } },
    });
    const status = await getOnboardingStatus(sb, OWNER, TENANT);
    expect(status.stage).toBe("ready");
    expect(status.percentComplete).toBe(100);
    expect(status.operatingModel).toEqual({
      done: true,
      value: "table_service",
      features: ["kitchen"],
    });
  });

  it("denies a caller who is not a member of this tenant, exactly like every other read (security boundary preserved)", async () => {
    assertTenantReadMock.mockRejectedValue(
      new Error("Forbidden — you do not belong to this restaurant tenant."),
    );
    const sb = makeSb({});
    await expect(getOnboardingStatus(sb, "stranger", TENANT)).rejects.toThrow(/Forbidden/);
  });
});

describe("recordOnboardingEvent — §20 funnel telemetry, reusing the canonical event system", () => {
  it("delegates straight to emitRestaurantEvent with the canonical envelope, not a parallel analytics path", async () => {
    const sb = {};
    await recordOnboardingEvent(sb, OWNER, {
      tenantId: TENANT,
      type: "restaurant.onboarding.business.completed",
      payload: { businessType: "restaurant" },
    });
    expect(emitRestaurantEventMock).toHaveBeenCalledWith(
      sb,
      OWNER,
      expect.objectContaining({
        type: "restaurant.onboarding.business.completed",
        tenantId: TENANT,
        payload: { businessType: "restaurant" },
        source: "onboarding",
      }),
    );
  });

  it("honors an explicit occurredAt — the deferred-identify path for pre-tenant steps (entered/welcome_viewed/business.started)", async () => {
    const sb = {};
    const capturedAt = "2024-01-01T00:00:00.000Z";
    await recordOnboardingEvent(sb, OWNER, {
      tenantId: TENANT,
      type: "restaurant.onboarding.entered",
      payload: {},
      occurredAt: capturedAt,
    });
    expect(emitRestaurantEventMock).toHaveBeenCalledWith(
      sb,
      OWNER,
      expect.objectContaining({ occurredAt: capturedAt }),
    );
  });

  it("§20 — a telemetry failure never throws out of this function; it reports non-delivery instead of blocking onboarding", async () => {
    // emitRestaurantEvent itself never throws (its own doc comment: best-effort),
    // it resolves {delivered:false}. This proves recordOnboardingEvent passes
    // that outcome through rather than treating it as an error.
    emitRestaurantEventMock.mockResolvedValue({
      delivered: false,
      duplicate: false,
      reason: "insufficient_privilege",
    });
    const sb = {};
    const result = await recordOnboardingEvent(sb, OWNER, {
      tenantId: TENANT,
      type: "restaurant.onboarding.resumed",
      payload: {},
    });
    expect(result).toEqual({ delivered: false, duplicate: false });
  });

  it("never leaks a business name or other free text — only flat, non-PII payload fields are accepted by the schema", async () => {
    const { recordOnboardingEventSchema } = await import("./contracts");
    const result = recordOnboardingEventSchema.safeParse({
      tenantId: TENANT,
      type: "restaurant.onboarding.business.completed",
      payload: { businessName: { nested: "object not allowed" } },
    });
    expect(result.success).toBe(false);
  });
});
