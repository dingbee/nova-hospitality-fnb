/* eslint-disable @typescript-eslint/no-explicit-any -- the mocked Supabase query builder mirrors the untyped server client boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  sendTemplateMessage: vi.fn().mockResolvedValue({ messages: [{ id: "wamid.template.1" }] }),
}));
import { processPendingWhatsAppOutboundMessages } from "./outbound-queue.server";
import { sendTemplateMessage, sendTextMessage } from "./providers/meta-cloud-api.server";

const queued = {
  id: "message-1",
  tenant_id: "tenant-1",
  property_id: "property-1",
  location_id: "location-1",
  conversation_id: "conversation-1",
  content: "Welcome",
  message_type: "text",
  payload: {},
  delivery_attempts: 1,
};
function fakeAdmin(outbound = queued) {
  const updates: Array<Record<string, unknown>> = [];
  const rpc = vi.fn(async () => ({ data: [outbound], error: null }));
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

const previousProviderDispatch = process.env.LEXIBITE_WHATSAPP_DISPATCH_ENABLED;

describe("WhatsApp outbound queue", () => {
  beforeEach(() => {
    process.env.LEXIBITE_WHATSAPP_DISPATCH_ENABLED = "true";
  });
  afterEach(() => {
    if (previousProviderDispatch === undefined) {
      delete process.env.LEXIBITE_WHATSAPP_DISPATCH_ENABLED;
    } else {
      process.env.LEXIBITE_WHATSAPP_DISPATCH_ENABLED = previousProviderDispatch;
    }
  });
  it("dispatches an approved template message through the same tenant-scoped outbox", async () => {
    const templateMessage = {
      ...queued,
      id: "message-template-1",
      content: "",
      message_type: "template",
      payload: {
        template: {
          name: "weekly_special",
          language: "en",
          components: [{ type: "body", parameters: [] }],
        },
        campaign_recipient_id: "recipient-1",
      },
    };
    const { admin, updates } = fakeAdmin(templateMessage);
    const result = await processPendingWhatsAppOutboundMessages(admin, {
      workerId: "worker-template",
    });
    expect(result).toEqual({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      campaignReconciliationRequired: 0,
      campaignDispatchDeferred: 0,
      campaignDispatchSuppressed: 0,
      providerDispatchDeferred: 0,
    });
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      { accessToken: "tenant-token", wabaId: "987654321", phoneNumberId: "123456789" },
      "255700000000",
      { name: "weekly_special", language: "en", components: [{ type: "body", parameters: [] }] },
      {},
    );
    expect(updates[0]).toMatchObject({
      provider_message_id: "wamid.template.1",
      status: "sent",
    });
    expect(updates).toContainEqual({ state: "sent", dispatched_at: expect.any(String) });
  });

  it("sends with the scoped tenant credential and records the provider message ID", async () => {
    const { admin, updates } = fakeAdmin();
    const result = await processPendingWhatsAppOutboundMessages(admin, { workerId: "worker-1" });
    expect(result).toEqual({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      campaignReconciliationRequired: 0,
      campaignDispatchDeferred: 0,
      campaignDispatchSuppressed: 0,
    });
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
  it("defers campaign messages without calling Meta unless the explicit dispatch gate is enabled", async () => {
    const previous = process.env.LEXIBITE_WHATSAPP_CAMPAIGN_DISPATCH_ENABLED;
    delete process.env.LEXIBITE_WHATSAPP_CAMPAIGN_DISPATCH_ENABLED;
    vi.clearAllMocks();
    const campaignMessage = {
      ...queued,
      id: "message-campaign-1",
      message_type: "template",
      payload: {
        campaign_id: "campaign-1",
        campaign_recipient_id: "recipient-1",
        template: { name: "weekly_special", language: "en", components: [] },
      },
    };
    const { admin, updates } = fakeAdmin(campaignMessage);
    try {
      const result = await processPendingWhatsAppOutboundMessages(admin, {
        workerId: "worker-campaign",
      });
      expect(result).toEqual({
        claimed: 1,
        sent: 0,
        retried: 0,
        failed: 0,
        campaignReconciliationRequired: 0,
        campaignDispatchDeferred: 1,
        campaignDispatchSuppressed: 0,
      });
      expect(sendTemplateMessage).not.toHaveBeenCalled();
      expect(updates[0]).toMatchObject({
        locked_at: null,
        locked_by: null,
        last_error: "campaign_dispatch_disabled",
      });
    } finally {
      if (previous === undefined) delete process.env.LEXIBITE_WHATSAPP_CAMPAIGN_DISPATCH_ENABLED;
      else process.env.LEXIBITE_WHATSAPP_CAMPAIGN_DISPATCH_ENABLED = previous;
    }
  });
  it("defers every provider message while the global dispatch gate is disabled", async () => {
    delete process.env.LEXIBITE_WHATSAPP_DISPATCH_ENABLED;
    vi.clearAllMocks();
    const { admin, updates } = fakeAdmin();
    const result = await processPendingWhatsAppOutboundMessages(admin, {
      workerId: "worker-provider-disabled",
    });
    expect(result).toEqual({
      claimed: 1,
      sent: 0,
      retried: 0,
      failed: 0,
      campaignReconciliationRequired: 0,
      campaignDispatchDeferred: 0,
      campaignDispatchSuppressed: 0,
      providerDispatchDeferred: 1,
    });
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      locked_at: null,
      locked_by: null,
      last_error: "provider_dispatch_disabled",
    });
  });
});
