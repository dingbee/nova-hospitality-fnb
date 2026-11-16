import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn(),
  assertEntitled: vi.fn(),
  registerIntegration: vi.fn(),
  updateIntegration: vi.fn(),
  exchangeEmbeddedSignupCode: vi.fn(),
  inspectAccessToken: vi.fn(),
  assertRequiredWhatsAppPermissions: vi.fn(),
  getWabaDetails: vi.fn(),
  listWabaPhoneNumbers: vi.fn(),
  registerVerifiedPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  checkPhoneNumberHealth: vi.fn(),
}));

vi.mock("@/modules/restaurant/core/access.server", () => ({
  assertCapability: mocks.assertCapability,
}));
vi.mock("@/modules/commercial/resolver.server", () => ({
  assertEntitled: mocks.assertEntitled,
}));
vi.mock("@/modules/api-platform/integrations.server", () => ({
  registerIntegration: mocks.registerIntegration,
  updateIntegration: mocks.updateIntegration,
}));
vi.mock("./meta-cloud-api.server", () => ({
  exchangeEmbeddedSignupCode: mocks.exchangeEmbeddedSignupCode,
  inspectAccessToken: mocks.inspectAccessToken,
  assertRequiredWhatsAppPermissions: mocks.assertRequiredWhatsAppPermissions,
  getWabaDetails: mocks.getWabaDetails,
  listWabaPhoneNumbers: mocks.listWabaPhoneNumbers,
  registerVerifiedPhoneNumber: mocks.registerVerifiedPhoneNumber,
  subscribeWabaToApp: mocks.subscribeWabaToApp,
  checkPhoneNumberHealth: mocks.checkPhoneNumberHealth,
}));

import { completeMetaWhatsAppSignup } from "./meta-onboarding.server";

const platform = { appId: "app-1", appSecret: "server-secret", graphApiVersion: "v27.0" };
const input = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  propertyId: "22222222-2222-4222-8222-222222222222",
  authorizationCode: "signup-code",
  wabaId: "123456789",
  phoneNumberId: "987654321",
  registrationPin: "123456",
  label: "Restaurant WhatsApp",
};

function makeSupabase(existingId: string | null = null) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: existingId ? { id: existingId } : null,
      error: null,
    }),
  };
  return { from: vi.fn().mockReturnValue(query), query };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertCapability.mockResolvedValue(undefined);
  mocks.assertEntitled.mockResolvedValue(undefined);
  mocks.exchangeEmbeddedSignupCode.mockResolvedValue({
    accessToken: "meta-access-token",
    tokenType: "bearer",
    expiresIn: 5184000,
  });
  mocks.inspectAccessToken.mockResolvedValue({
    app_id: "app-1",
    is_valid: true,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
  });
  mocks.assertRequiredWhatsAppPermissions.mockReturnValue(undefined);
  mocks.getWabaDetails.mockResolvedValue({ id: input.wabaId });
  mocks.listWabaPhoneNumbers.mockResolvedValue([
    {
      id: input.phoneNumberId,
      display_phone_number: "+255700000000",
      verified_name: "Restaurant",
      quality_rating: "GREEN",
    },
  ]);
  mocks.registerVerifiedPhoneNumber.mockResolvedValue({ success: true });
  mocks.subscribeWabaToApp.mockResolvedValue({ success: true });
  mocks.checkPhoneNumberHealth.mockResolvedValue({ quality_rating: "GREEN" });
  mocks.registerIntegration.mockResolvedValue({ id: "integration-1" });
  mocks.updateIntegration.mockResolvedValue({ id: "integration-existing" });
});

describe("Meta Embedded Signup server completion", () => {
  it("authorizes tenant/property, validates Meta assets, and stores the token through the encrypted vault", async () => {
    const sb = makeSupabase();
    const result = await completeMetaWhatsAppSignup(sb, "user-1", input, platform);

    expect(mocks.assertCapability).toHaveBeenCalledWith(
      sb,
      "user-1",
      input.tenantId,
      "tenant.manage",
      { propertyId: input.propertyId },
    );
    expect(mocks.assertEntitled).toHaveBeenCalledWith(
      sb,
      input.tenantId,
      "advanced_integrations",
      { propertyId: input.propertyId },
    );
    expect(mocks.registerVerifiedPhoneNumber).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "meta-access-token" }),
      input.registrationPin,
      platform,
    );
    expect(mocks.subscribeWabaToApp).toHaveBeenCalled();
    expect(mocks.registerIntegration).toHaveBeenCalledWith(
      sb,
      "user-1",
      expect.objectContaining({
        provider: "meta-whatsapp",
        channelKey: "whatsapp",
        integrationType: "channel",
        secret: "meta-access-token",
      }),
    );
    expect(result).toMatchObject({
      integrationId: "integration-1",
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: "+255700000000",
    });
    expect(result).not.toHaveProperty("accessToken");
  });

  it("rejects a Meta token issued to a different application before persistence", async () => {
    const sb = makeSupabase();
    mocks.inspectAccessToken.mockResolvedValueOnce({
      app_id: "another-app",
      is_valid: true,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
    });

    await expect(completeMetaWhatsAppSignup(sb, "user-1", input, platform)).rejects.toThrow(
      "Meta token belongs to a different application.",
    );
    expect(mocks.registerIntegration).not.toHaveBeenCalled();
  });

  it("rejects a phone number that is not a member of the selected WABA", async () => {
    const sb = makeSupabase();
    mocks.listWabaPhoneNumbers.mockResolvedValueOnce([]);

    await expect(completeMetaWhatsAppSignup(sb, "user-1", input, platform)).rejects.toThrow(
      "The selected phone number is not registered under this WABA.",
    );
    expect(mocks.registerIntegration).not.toHaveBeenCalled();
  });

  it("stops before Meta calls when the operator lacks tenant/property authority", async () => {
    const sb = makeSupabase();
    mocks.assertCapability.mockRejectedValueOnce(new Error("Forbidden"));

    await expect(completeMetaWhatsAppSignup(sb, "user-1", input, platform)).rejects.toThrow(
      "Forbidden",
    );
    expect(mocks.exchangeEmbeddedSignupCode).not.toHaveBeenCalled();
  });

  it("rotates the existing tenant/property integration instead of creating a duplicate", async () => {
    const sb = makeSupabase("integration-existing");
    const result = await completeMetaWhatsAppSignup(sb, "user-1", input, platform);

    expect(mocks.updateIntegration).toHaveBeenCalledWith(
      sb,
      "user-1",
      expect.objectContaining({
        integrationId: "integration-existing",
        secret: "meta-access-token",
        status: "active",
      }),
    );
    expect(mocks.registerIntegration).not.toHaveBeenCalled();
    expect(result.integrationId).toBe("integration-existing");
  });
});
