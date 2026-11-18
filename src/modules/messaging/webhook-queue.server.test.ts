/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double mirrors untyped query builders. */
import { describe, expect, it, vi } from "vitest";
vi.mock("./guest-commerce.server", () => ({
  handleWhatsAppGuestCommerceMessage: vi.fn().mockResolvedValue({ handled: false }),
}));
import { processPendingMetaWebhookEvents } from "./webhook-queue.server";

const baseEvent = {
  id: "event-1",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  property_id: "22222222-2222-4222-8222-222222222222",
  location_id: "33333333-3333-4333-8333-333333333333",
  binding_id: "44444444-4444-4444-8444-444444444444",
  phone_number_id: "987654321",
  event_type: "messages",
  payload: {
    value: {
      messages: [
        {
          id: "wamid.inbound.1",
          from: "255700000000",
          timestamp: "1794850000",
          type: "text",
          text: { body: "Hello LexiBite" },
        },
      ],
    },
  },
  attempt_count: 1,
  max_attempts: 8,
};

function makeDb(
  events: unknown[],
  options: {
    messageInsertError?: { code: string } | null;
    statusResult?: boolean;
    templateUpdateFound?: boolean;
  } = {},
) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string) => {
    if (name === "wa_claim_webhook_events") return { data: events, error: null };
    if (name === "wa_apply_message_delivery_status") {
      return { data: options.statusResult ?? true, error: null };
    }
    return { data: null, error: { message: "unknown_rpc" } };
  });

  const from = vi.fn((table: string) => {
    const builder: Record<string, any> = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      or: vi.fn(() => builder),
      in: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({
        data:
          table === "wa_message_templates" && options.templateUpdateFound
            ? { id: "template-row-1" }
            : null,
        error: null,
      })),
      single: vi.fn(async () => ({ data: { id: "conversation-1" }, error: null })),
      insert: vi.fn((row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return builder;
      }),
      update: vi.fn((patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        return builder;
      }),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        const result =
          table === "wa_messages" && options.messageInsertError
            ? { error: options.messageInsertError }
            : { error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  });

  return { db: { from, rpc }, inserts, updates, rpc };
}

describe("Meta WhatsApp durable webhook worker", () => {
  it("creates one scoped conversation and stores inbound messages idempotently", async () => {
    const { db, inserts, updates } = makeDb([baseEvent]);

    const result = await processPendingMetaWebhookEvents(db, { workerId: "worker-1" });

    expect(result).toEqual({ claimed: 1, processed: 1, retried: 0, deadLettered: 0 });
    expect(inserts.find((item) => item.table === "wa_conversations")?.row).toMatchObject({
      tenant_id: baseEvent.tenant_id,
      property_id: baseEvent.property_id,
      location_id: baseEvent.location_id,
      binding_id: baseEvent.binding_id,
      wa_user_id: "255700000000",
    });
    expect(inserts.find((item) => item.table === "wa_messages")?.row).toMatchObject({
      provider_message_id: "wamid.inbound.1",
      direction: "inbound",
      status: "received",
      content: "Hello LexiBite",
    });
    expect(updates.find((item) => item.table === "wa_webhook_events")?.patch).toMatchObject({
      status: "processed",
      locked_at: null,
      locked_by: null,
    });
  });

  it("treats a duplicate provider message ID as already persisted", async () => {
    const { db } = makeDb([baseEvent], { messageInsertError: { code: "23505" } });
    const result = await processPendingMetaWebhookEvents(db);
    expect(result.processed).toBe(1);
    expect(result.retried).toBe(0);
  });

  it("retries a delivery status that arrives before its outbound message exists", async () => {
    const statusEvent = {
      ...baseEvent,
      payload: {
        value: {
          statuses: [{ id: "wamid.outbound.1", status: "delivered", timestamp: "1794850000" }],
        },
      },
    };
    const { db, updates } = makeDb([statusEvent], { statusResult: false });

    const result = await processPendingMetaWebhookEvents(db, { workerId: "worker-2" });

    expect(result).toEqual({ claimed: 1, processed: 0, retried: 1, deadLettered: 0 });
    expect(updates.find((item) => item.table === "wa_webhook_events")?.patch).toMatchObject({
      status: "retry",
      last_error: "event_processing_failed",
      locked_at: null,
    });
  });

  it("reconciles Meta template approval webhooks into the scoped template registry", async () => {
    const templateEvent = {
      ...baseEvent,
      event_type: "message_template_status_update",
      payload: {
        value: {
          message_template_status_update: {
            message_template_id: "meta-template-1",
            event: "APPROVED",
          },
        },
      },
    };
    const { db, updates } = makeDb([templateEvent], { templateUpdateFound: true });
    const result = await processPendingMetaWebhookEvents(db, { workerId: "template-worker" });
    expect(result).toEqual({ claimed: 1, processed: 1, retried: 0, deadLettered: 0 });
    expect(updates.find((item) => item.table === "wa_message_templates")?.patch).toMatchObject({
      status: "approved",
      rejection_reason: null,
    });
  });

  it("moves an event to dead letter after its maximum attempts", async () => {
    const exhausted = {
      ...baseEvent,
      payload: {
        value: {
          statuses: [{ id: "wamid.outbound.1", status: "delivered", timestamp: "1794850000" }],
        },
      },
      attempt_count: 8,
      max_attempts: 8,
    };
    const { db, updates } = makeDb([exhausted], { statusResult: false });

    const result = await processPendingMetaWebhookEvents(db);

    expect(result.deadLettered).toBe(1);
    expect(updates.find((item) => item.table === "wa_webhook_events")?.patch).toMatchObject({
      status: "dead_letter",
      last_error: "event_processing_failed",
    });
  });
});
