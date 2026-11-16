import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkPhoneNumberHealth: vi.fn(),
}));

vi.mock("@/modules/messaging/providers/meta-cloud-api.server", () => ({
  checkPhoneNumberHealth: mocks.checkPhoneNumberHealth,
  MetaGraphError: class MetaGraphError extends Error {},
}));

import { metaWhatsAppAdapter } from "./meta-whatsapp.server";

const config = {
  wabaId: "123456789",
  phoneNumberId: "987654321",
  graphApiVersion: "v27.0",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Meta WhatsApp channel health adapter", () => {
  it("reports a connected phone as healthy", async () => {
    mocks.checkPhoneNumberHealth.mockResolvedValueOnce({ status: "CONNECTED" });
    const result = await metaWhatsAppAdapter.testConnection(config, "encrypted-vault-token");

    expect(result).toMatchObject({
      ok: true,
      provider: "meta-whatsapp",
      status: 200,
    });
    expect(mocks.checkPhoneNumberHealth).toHaveBeenCalledWith(
      {
        accessToken: "encrypted-vault-token",
        wabaId: config.wabaId,
        phoneNumberId: config.phoneNumberId,
      },
      { graphApiVersion: config.graphApiVersion },
    );
  });

  it("does not report an unconnected phone as healthy", async () => {
    mocks.checkPhoneNumberHealth.mockResolvedValueOnce({ status: "PENDING" });
    const result = await metaWhatsAppAdapter.testConnection(config, "encrypted-vault-token");

    expect(result).toMatchObject({ ok: false, provider: "meta-whatsapp", status: 409 });
  });

  it("sanitizes unexpected provider failures", async () => {
    mocks.checkPhoneNumberHealth.mockRejectedValueOnce(new Error("sensitive provider detail"));
    const result = await metaWhatsAppAdapter.testConnection(config, "encrypted-vault-token");

    expect(result).toMatchObject({ ok: false, provider: "meta-whatsapp", status: null });
    expect(result.message).not.toContain("sensitive provider detail");
  });

  it("rejects incomplete or malformed provider configuration", () => {
    expect(() => metaWhatsAppAdapter.validateConfig({ phoneNumberId: config.phoneNumberId })).toThrow();
  });
});
