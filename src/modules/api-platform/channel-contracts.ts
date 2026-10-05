import { z } from "zod";

export type ChannelProviderKey = string;

export const CHANNEL_TYPES = ["marketplace", "ordering_platform", "delivery", "aggregator"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_STATUSES = ["active", "disabled", "error"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const channelConnectionConfigSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  languageCode: z.string().trim().min(2).max(10).default("en"),
  businessId: z.string().trim().max(120).optional(),
});

export type ChannelConnectionConfig = z.infer<typeof channelConnectionConfigSchema>;

export const createChannelConnectionSchema = z.object({
  tenantId: z.string().uuid(),
  propertyId: z.string().uuid().nullish(),
  providerKey: z.string().trim().min(2).max(80),
  label: z.string().trim().min(2).max(120),
  config: channelConnectionConfigSchema,
  apiKey: z.string().min(8).max(4000),
});

export const updateChannelConnectionSchema = z.object({
  tenantId: z.string().uuid(),
  integrationId: z.string().uuid(),
  propertyId: z.string().uuid().nullish(),
  label: z.string().trim().min(2).max(120).optional(),
  config: channelConnectionConfigSchema.partial().optional(),
  apiKey: z.string().min(8).max(4000).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

export const listChannelConnectionsSchema = z.object({ tenantId: z.string().uuid() });
export const testChannelConnectionSchema = z.object({
  tenantId: z.string().uuid(),
  integrationId: z.string().uuid(),
});

export type CreateChannelConnectionInput = z.infer<typeof createChannelConnectionSchema>;
export type UpdateChannelConnectionInput = z.infer<typeof updateChannelConnectionSchema>;

export type ChannelCapability =
  | "catalog.read"
  | "catalog.write"
  | "orders.read"
  | "orders.write"
  | "order_status.write"
  | "webhooks";

export type ChannelProviderDefinition = {
  key: ChannelProviderKey;
  name: string;
  description: string;
  type: ChannelType;
  capabilities: readonly ChannelCapability[];
  setup: {
    credentialLabel: string;
    projectLabel: string;
    businessLabel?: string;
    docsUrl?: string;
  };
};

export type ChannelConnection = {
  id: string;
  tenantId: string;
  propertyId: string | null;
  providerKey: ChannelProviderKey;
  label: string;
  status: ChannelStatus;
  config: ChannelConnectionConfig;
  lastError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
