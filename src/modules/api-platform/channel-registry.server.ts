import { CHANNEL_PROVIDERS, getChannelProviderDefinition } from "./channel-catalog";
import type { ChannelConnectionConfig, ChannelProviderKey } from "./channel-contracts";

export { CHANNEL_PROVIDERS };

export function getChannelProvider(key: string) {
  return getChannelProviderDefinition(key);
}

export function assertChannelProvider(key: string) {
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
    languageCode: config.languageCode.trim() || "en",
  };
}
