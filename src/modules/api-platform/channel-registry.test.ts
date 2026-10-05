import { describe, expect, it } from "vitest";
import { CHANNEL_PROVIDERS, getChannelProviderDefinition } from "./channel-catalog";
import { normaliseChannelConfig } from "./channel-registry.server";

describe("universal channel registry", () => {
  it("ships Ordering.co as a provider, not Piki as a provider", () => {
    expect(CHANNEL_PROVIDERS.map((provider) => provider.key)).toEqual(["ordering.co"]);
    expect(getChannelProviderDefinition("piki")).toBeNull();
  });

  it("normalises tenant connection metadata without accepting a transport URL", () => {
    const config = normaliseChannelConfig("ordering.co", {
      projectId: "piki-project",
      languageCode: " en ",
      businessId: "123",
    });
    expect(config).toEqual({
      projectId: "piki-project",
      languageCode: "en",
      businessId: "123",
    });
    expect("baseUrl" in config).toBe(false);
  });
});
