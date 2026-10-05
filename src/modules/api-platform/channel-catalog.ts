import type { ChannelDefinition, ChannelProviderDefinition } from "./channel-contracts";

/**
 * Universal channel definitions describe the customer-facing channel/deployment.
 * Providers remain transport adapters underneath this layer.
 */
export const CHANNELS: readonly ChannelDefinition[] = [
  {
    key: "piki",
    name: "PIKI",
    description: "External online-ordering channel connected through the Ordering.co adapter.",
    providerKey: "ordering.co",
    category: "ordering_platform",
  },
];


export const CHANNEL_PROVIDERS: readonly ChannelProviderDefinition[] = [
  {
    key: "ordering.co",
    name: "Ordering.co",
    description:
      "Connect an Ordering.co project as an external channel. Provider-specific transport and configuration stay inside its adapter.",
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
      fields: [
        {
          key: "projectId",
          label: "Project ID",
          type: "text",
          required: true,
          placeholder: "Provider project identifier",
        },
        {
          key: "languageCode",
          label: "Language",
          type: "text",
          required: false,
          placeholder: "en",
        },
        {
          key: "businessId",
          label: "Business ID",
          type: "text",
          required: false,
          placeholder: "Optional provider business identifier",
        },
      ],
      credential: {
        label: "API key",
        kind: "api_key",
        required: true,
      },
      docsUrl: "https://docs.ordering.co/docs/products/dashboard/settings/pro/developers/api-keys/",
    },
  },
];

export function getChannelProviderDefinition(key: string) {
  return CHANNEL_PROVIDERS.find((provider) => provider.key === key) ?? null;
}

export function getChannelDefinition(key: string) {
  return CHANNELS.find((channel) => channel.key === key) ?? null;
}

