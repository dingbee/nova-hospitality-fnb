import { z } from "zod";
import { checkPhoneNumberHealth, MetaGraphError } from "@/modules/messaging/providers/meta-cloud-api.server";
import type { ChannelAdapter, ChannelHealth } from "./channel-adapter.server";

const configSchema = z.object({
  wabaId: z.string().regex(/^\d{3,32}$/),
  phoneNumberId: z.string().regex(/^\d{3,32}$/),
  graphApiVersion: z.string().regex(/^v\d+\.\d+$/).default("v27.0"),
});

export const metaWhatsAppAdapter: ChannelAdapter = {
  providerKey: "meta-whatsapp",

  validateConfig(config) {
    return configSchema.parse(config);
  },

  async testConnection(config, credential): Promise<ChannelHealth> {
    const parsed = configSchema.parse(config);
    const checkedAt = new Date().toISOString();
    try {
      const health = await checkPhoneNumberHealth(
        {
          accessToken: credential,
          wabaId: parsed.wabaId,
          phoneNumberId: parsed.phoneNumberId,
        },
        { graphApiVersion: parsed.graphApiVersion },
      );
      const connected = health.status === "CONNECTED";
      return {
        ok: connected,
        provider: "meta-whatsapp",
        status: connected ? 200 : 409,
        message: connected
          ? "WhatsApp Business phone number is connected."
          : "Meta reports that the WhatsApp phone number is not connected.",
        checkedAt,
      };
    } catch (error) {
      if (error instanceof MetaGraphError) {
        const message =
          error.status === 401 || error.graphCode === 190
            ? "Meta access token is invalid or expired."
            : error.retryable
              ? "Meta API is temporarily unavailable; retry the connection check."
              : "Meta rejected the WhatsApp connection health check.";
        return {
          ok: false,
          provider: "meta-whatsapp",
          status: error.status,
          message,
          checkedAt,
        };
      }
      return {
        ok: false,
        provider: "meta-whatsapp",
        status: null,
        message: "Unable to verify the WhatsApp connection.",
        checkedAt,
      };
    }
  },
};
