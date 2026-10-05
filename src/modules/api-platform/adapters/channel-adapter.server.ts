import type { ChannelConnectionConfig, ChannelProviderKey } from "../channel-contracts";

export type ChannelHealth = {
  ok: boolean;
  provider: ChannelProviderKey;
  status: number | null;
  message: string;
  checkedAt: string;
};

export type ChannelAdapter = {
  providerKey: ChannelProviderKey;
  validateConfig(config: ChannelConnectionConfig): ChannelConnectionConfig;
  testConnection(config: ChannelConnectionConfig, credential: string): Promise<ChannelHealth>;
};
