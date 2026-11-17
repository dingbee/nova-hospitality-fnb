/* eslint-disable @typescript-eslint/no-explicit-any -- the mocked Supabase query builder mirrors the untyped server client boundary. */
import { describe, expect, it, vi } from "vitest";
vi.mock("@/modules/api-platform/integrations.server", () => ({
  getIntegrationSecret: vi.fn().mockResolvedValue("tenant-token"),
}));
vi.mock("./providers/meta-cloud-api.server", () => ({
  MetaGraphError: class MetaGraphError extends Error {
    status: number | null;
    retryAfterMs: number | null;
    constructor(status: number | null, retryAfterMs: number | null = null) {
      super("provider");
      this.status = status;
      this.retryAfterMs = retryAfterMs;
    }
  },
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: "wamid.sent.1" }] }),
}));
import { processPendingWhatsAppOutboundMessages } from "./outbound-queue.server";
import { sendTextMessage } from "./providers/meta-cloud-api.server";

const queued = {
  id: "message-1",
  tenant_id: "tenant-1",
  property_id: "property-1",
  location_id: "location-1",
  conversation_id: "conversation-1",
  content: "Welcome",
  delivery_attempts: 1,
};
function fakeAdmin() {
  const updates: Array<Record<string, unknown>> = [];
  const rpc = vi.fn(async () => ({ data: [queued], error: null }));
  const from = vi.fn((table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => {
        if (table === "wa_conversations")
          return {
            data: { binding_id: "binding-1", wa_user_id: "255700000000", status: "open" },
            error: null,
          };
        if (table === "wa_phone_number_bindings")
          return {
            data: {
              id: "binding-1",
              phone_number_id: "123456789",
              integration_id: "integration-1",
              status: "active",
            },
            error: null,
          };
        return {
          data: {
            id: "integration-1",
            status: "active",
            config: { wabaId: "987654321" },
            provider: "meta-whatsapp",
            channel_key: "whatsapp",
            integration_type: "channel",
          },
          error: null,
        };
      },
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return builder;
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
    };
    return builder;
  });
  return { admin: { rpc, from }, updates };
}

describe("WhatsApp outbound queue", () => {
  it("sends with the scoped tenant credential and records the provider message ID", async () => {
    const { admin, updates } = fakeAdmin();
    const result = await processPendingWhatsAppOutboundMessages(admin, { workerId: "worker-1" });
    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(sendTextMessage).toHaveBeenCalledWith(
      { accessToken: "tenant-token", wabaId: "987654321", phoneNumberId: "123456789" },
      "255700000000",
      "Welcome",
      {},
    );
    expect(updates[0]).toMatchObject({
      provider_message_id: "wamid.sent.1",
      status: "sent",
      locked_by: null,
    });
  });
});
