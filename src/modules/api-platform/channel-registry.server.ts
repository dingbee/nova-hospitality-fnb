import type {
  ChannelConnectionConfig,
  ChannelProviderDefinition,
  ChannelProviderKey,
} from "./channel-contracts";

export const CHANNEL_PROVIDERS: readonly ChannelProviderDefinition[] = [
  {
    key: "ordering.co",
    name: "Ordering.co",
    description:
      "Connect an Ordering.co project as an external ordering channel. Piki is an Ordering.co deployment; the connector is project-based, not Piki-hardcoded.",
    type: "ordering_platform",
    capabilities: [
      "catalog.read",
      "catalog.write",
      "orders.read",
      "orders.write",
      "order_status.write",
      "webhooks",
    ],
    setup: {
      credentialLabel: "Ordering.co API key",
      projectLabel: "Project ID",
      businessLabel: "Business ID (optional)",
      docsUrl: "https://docs.ordering.co/docs/products/dashboard/settings/pro/developers/api-keys/",
    },
  },
];

export function getChannelProvider(key: string): ChannelProviderDefinition | null {
  return CHANNEL_PROVIDERS.find((provider) => provider.key === key) ?? null;
}

export function assertChannelProvider(key: string): ChannelProviderDefinition {
  const provider = getChannelProvider(key);
  if (!provider) throw new Error(`Unsupported channel provider: ${key}`);
  return provider;
}

export function normaliseChannelConfig(
  providerKey: ChannelProviderKey,
  config: ChannelConnectionConfig,
): ChannelConnectionConfig {
  assertChannelProvider(providerKey);
  return {
    ...config,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    languageCode: config.languageCode.trim() || "en",
  };
}
