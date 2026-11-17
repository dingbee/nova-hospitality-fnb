import { z } from "zod";
import type { ChannelAdapter, ChannelHealth } from "./channel-adapter.server";
import type { ChannelConnectionConfig } from "../channel-contracts";

const orderingConfigSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  languageCode: z.string().trim().min(2).max(10).default("en"),
  businessId: z.string().trim().max(120).optional(),
}).passthrough();

const API_BASE = "https://api.ordering.co";

function buildUrl(config: ChannelConnectionConfig, resource: string) {
  const parsed = orderingConfigSchema.parse(config);
  return `${API_BASE}/v400/${encodeURIComponent(parsed.languageCode)}/${encodeURIComponent(parsed.projectId)}/${resource}`;
}

async function request(config: ChannelConnectionConfig, credential: string, resource: string) {
  return fetch(buildUrl(config, resource), {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": credential,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

export const orderingCoAdapter: ChannelAdapter = {
  providerKey: "ordering.co",

  validateConfig(config) {
    return orderingConfigSchema.parse(config);
  },

  async testConnection(config, credential): Promise<ChannelHealth> {
    const response = await request(
      config,
      credential,
      "orders?orderBy=-id&page=1&page_size=1&mode=dashboard",
    );
    const checkedAt = new Date().toISOString();

    if (response.ok) {
      return {
        ok: true,
        provider: "ordering.co",
        status: response.status,
        message: "Provider connection verified.",
        checkedAt,
      };
    }

    return {
      ok: false,
      provider: "ordering.co",
      status: response.status,
      message:
        response.status === 401 || response.status === 403
          ? "Provider rejected the credential or project access."
          : `Provider returned HTTP ${response.status}.`,
      checkedAt,
    };
  },
};
