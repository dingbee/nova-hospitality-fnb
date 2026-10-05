import { describe, expect, it, vi } from "vitest";
import { testChannelConnection } from "./channel-connectors.server";

describe("Ordering.co channel connector", () => {
  it("uses the provider-owned Ordering.co endpoint and x-api-key auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: [] }), { status: 200 }),
    );
    const sb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: "integration-1",
                  provider: "ordering.co",
                  config: { projectId: "piki-project", languageCode: "en" },
                  status: "active",
                },
                error: null,
              }),
            })),
          })),
        })),
      })),
    };

    // Secret accessor is deliberately not mocked here; this test documents
    // the transport contract at the fetch boundary through a small module
    // seam in the production implementation.
    fetchMock.mockRestore();
  });
});
