import type { ChannelProviderDefinition } from "./channel-contracts";

/**
 * Provider metadata is developer-controlled adapter metadata.
 * Customer-facing channel identities are stored in api_channel_definitions.
 */
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
  {
    key: "meta-whatsapp",
    name: "Meta WhatsApp Business",
    description:
      "Native WhatsApp Business Platform messaging connection. Credentials are provisioned only through Embedded Signup.",
    type: "messaging",
    capabilities: ["webhooks"],
    setup: {
      fields: [],
      credential: {
        label: "Managed by Meta Embedded Signup",
        kind: "secret",
        required: false,
      },
    },
  },
];

export function getChannelProviderDefinition(key: string) {
  return CHANNEL_PROVIDERS.find((provider) => provider.key === key) ?? null;
}
