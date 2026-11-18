/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double mirrors untyped query builders. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn(),
  assertEntitled: vi.fn(),
  writeCommercialAudit: vi.fn(),
}));

vi.mock("@/modules/restaurant/core/access.server", () => ({
  assertCapability: mocks.assertCapability,
}));
vi.mock("@/modules/commercial/resolver.server", () => ({
  assertEntitled: mocks.assertEntitled,
}));
vi.mock("@/modules/commercial/audit.server", () => ({
  writeCommercialAudit: mocks.writeCommercialAudit,
}));

import { bindMetaWhatsAppPhoneNumber, disableMetaWhatsAppIntegration } from "./bindings.server";

const input = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  propertyId: "22222222-2222-4222-8222-222222222222",
  locationId: "33333333-3333-4333-8333-333333333333",
  integrationId: "44444444-4444-4444-8444-444444444444",
  phoneNumberId: "987654321",
};

function makeSb(options: {
  integration?: Record<string, any> | null;
  location?: Record<string, any> | null;
  binding?: Record<string, any> | null;
  } = {},
) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const from = vi.fn((table: string) => {
    const builder: Record<string, any> = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      order: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => {
        if (table === "api_integrations")
          return {
            data:
              options.integration === undefined
                ? {
                    id: input.integrationId,
                    tenant_id: input.tenantId,
                    property_id: input.propertyId,
                    provider: "meta-whatsapp",
                    channel_key: "whatsapp",
                    integration_type: "channel",
          status: "active",
          config: {
                      wabaId: "123456789",
                      phoneNumbers: [
                        {
                          id: input.phoneNumberId,
                          displayPhoneNumber: "+255700000000",
              verifiedName: "Restaurant",
                          qualityRating: "GREEN",
                        },
                      ],
                    },
                  }
                : options.integration,
            error: null,
          };
        if (table === "restaurant_locations")
          return {
            data:
              options.location === undefined
                ? {
          id: input.locationId,
                    tenant_id: input.tenantId,
                    property_id: input.propertyId,
                    location_type: "outlet",
                    is_storage: false,
                    status: "active",
                  }
                : options.location,
            error: null,
          };
        return { data: options.binding ?? null, error: null };
      }),
      insert: vi.fn((row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return builder;
      }),
      update: vi.fn((patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        return builder;
      }),
      single: vi.fn(async () => ({ data: { id: "binding-1" }, error: null })),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(resolve, reject),
    };
    return builder;
  });
  return { sb: { from }, inserts, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertCapability.mockResolvedValue(undefined);
  mocks.assertEntitled.mockResolvedValue(undefined);
  mocks.writeCommercialAudit.mockResolvedValue(undefined);
});

describe("Meta WhatsApp receiving-number bindings", () => {
  it("binds only a server-verified phone asset to an active outlet", async () => {
    const { sb, inserts } = makeSb();
    const result = await bindMetaWhatsAppPhoneNumber(sb, "user-1", input);

    expect(result).toMatchObject({
      id: "binding-1",
      phoneNumberId: input.phoneNumberId,
      locationId: input.locationId,
      displayPhoneNumber: "+255700000000",
    });
    expect(inserts[0]).toMatchObject({
      table: "wa_phone_number_bindings",
      row: {
        tenant_id: input.tenantId,
        property_id: input.propertyId,
        location_id: input.locationId,
        integration_id: input.integrationId,
        waba_id: "123456789",
        phone_number_id: input.phoneNumberId,
        status: "active",
      },
    });
    expect(mocks.assertCapability).toHaveBeenCalled();
    expect(mocks.assertEntitled).toHaveBeenCalled();
    expect(mocks.writeCommercialAudit).toHaveBeenCalled();
  });

  it("rejects a phone number not returned by the verified Embedded Signup", async () => {
    const { sb, inserts } = makeSb({
      integration: {
        id: input.integrationId,
        status: "active",
        config: { wabaId: "123456789", phoneNumbers: [{ id: "111111111" }] },
      },
    });

    await expect(bindMetaWhatsAppPhoneNumber(sb, "user-1", input)).rejects.toThrow(
      "The selected receiving number is not part of the server-verified Meta signup.",
    );
    expect(inserts).toHaveLength(0);
  });

  it("rejects storage and inactive locations", async () => {
    const { sb, inserts } = makeSb({
      location: {
        id: input.locationId,
        tenant_id: input.tenantId,
        property_id: input.propertyId,
        location_type: "store",
        is_storage: true,
        status: "active",
      },
    });

    await expect(bindMetaWhatsAppPhoneNumber(sb, "user-1", input)).rejects.toThrow(
      "The selected location is not an active customer-facing outlet in this property.",
    );
    expect(inserts).toHaveLength(0);
  });

  it("disables the integration and all of its receiving-number bindings", async () => {
    const { sb, updates } = makeSb({
      integration: {
        id: input.integrationId,
        provider: "meta-whatsapp",
        channel_key: "whatsapp",
        status: "active",
      },
    });

    const result = await disableMetaWhatsAppIntegration(sb, "user-1", {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      integrationId: input.integrationId,
    });

    expect(result.status).toBe("disabled");
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "api_integrations", patch: { status: "disabled" } }),
        expect.objectContaining({
          table: "wa_phone_number_bindings",
          patch: { status: "disabled" },
        }),
      ]),
    );
  });
});
