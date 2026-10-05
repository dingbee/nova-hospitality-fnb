import { describe, expect, it } from "vitest";
import { getChannelAdapter, listChannelAdapters } from "./index.server";

describe("channel adapter registry", () => {
  it("resolves adapters by provider key", () => {
    const adapter = getChannelAdapter("ordering.co");
    expect(adapter.providerKey).toBe("ordering.co");
  });

  it("keeps provider-specific validation inside the adapter", () => {
    const adapter = getChannelAdapter("ordering.co");
    expect(
      adapter.validateConfig({
        projectId: "provider-project",
        languageCode: "en",
      }),
    ).toEqual({
      projectId: "provider-project",
      languageCode: "en",
    });
    expect(listChannelAdapters().map((item) => item.providerKey)).toContain("ordering.co");
  });
});
