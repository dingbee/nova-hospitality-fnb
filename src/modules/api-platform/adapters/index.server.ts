import type { ChannelProviderKey } from "../channel-contracts";
import type { ChannelAdapter } from "./channel-adapter.server";
import { orderingCoAdapter } from "./ordering-co.server";

const CHANNEL_ADAPTERS: readonly ChannelAdapter[] = [
  orderingCoAdapter,
];

export function getChannelAdapter(providerKey: ChannelProviderKey): ChannelAdapter {
  const adapter = CHANNEL_ADAPTERS.find((item) => item.providerKey === providerKey);
  if (!adapter) throw new Error(`No channel adapter is registered for ${providerKey}`);
  return adapter;
}

export function listChannelAdapters(): readonly ChannelAdapter[] {
  return CHANNEL_ADAPTERS;
}
