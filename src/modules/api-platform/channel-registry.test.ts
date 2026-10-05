import { describe, expect, it } from "vitest";
import { CHANNEL_PROVIDERS, getChannelProviderDefinition } from "./channel-catalog";
import { normaliseChannelConfig } from "./channel-registry.server";

describe("universal channel registry", () => {
  it("registers providers without creating product-specific provider keys", () => {
    expect(CHANNEL_PROVIDERS.map((provider) => provider.key)).toEqual(["ordering.co"]);
    expect(getChannelProviderDefinition("piki")).toBeNull();
  });

  it("keeps customer-facing channel identities out of the provider adapter catalogue", () => {
    expect(getChannelProviderDefinition("ordering.co")?.name).toBe("Ordering.co");
  });

  it("keeps the universal connection config provider-neutral", () => {
    const config = normaliseChannelConfig("ordering.co", {
      providerProject: "example-project",
      region: "tz",
    });

    expect(config).toEqual({
      providerProject: "example-project",
      region: "tz",
    });
    expect("baseUrl" in config).toBe(false);
  });
});
