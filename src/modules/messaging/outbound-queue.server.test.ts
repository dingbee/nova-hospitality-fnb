/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double mirrors untyped query builders. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptSecret: vi.fn(),
  getIntegrationSecret: vi.fn(),
  sendTextMessage: vi.fn(),
  assertCapability: vi.fn(),
  writeCommercialAudit: vi.fn(),
}));

vi.mock("@/modules/api-platform/crypto.server", () => ({
  decryptSecret: mocks.decryptSecret,
}));
vi.mock("@/modules/api-platform/integrations.server", () => ({
  getIntegrationSecret: mocks.getIntegrationSecret,
}));
vi.mock("@/modules/restaurant/core/access.server", () => ({
  assertCapability: mocks.assertCapability,
}));
vi.mock("@/modules/commercial/audit.server", () => ({
  writeCommercialAudit: mocks.writeCommercialAudit,
}));
vi.mock("./providers/meta-cloud-api.server", () => ({
  MetaGraphError: class MetaGraphError extends Error {
    status: number | null;
    code: number | null;
    constructor(message: string, status: number | null, code: number | null = null) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  sendTextMessage: mocks.sendTextMessage,
}));

import {
  processPendingMetaOutboundJobs,
  requeueMetaOutboundJob,
} from "./outbound-queue.server";

const job = {
  id: "job-1",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  property_id: "22222222-2222-4222-8222-222222222222",
  location_id: "33333333-3333-4333-8333-333333333333",
  binding_id: "44444444-4444-4444-8444-444444444444",
  conversation_id: "55555555-5555-4555-8555-555555555555",
  portal_session_id: "66666666-6666-4666-8666-666666666666",
  recipient_phone: "255700000000",
  body_ciphertext: "cipher",
  body_iv: "iv",
  body_tag: "tag",
  attempt_count: 1,
  max_attempts: 6,
};

function makeDb(options: {
  jobs?: unknown[];
  existingMessage?: Record<string, unknown> | null;
  lastMessageAt?: string;
  messageInsertError?: { code: string } | null;
  requeueJob?: Record<string, unknown> | null;
} = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const rpc = vi.fn(async () => ({ data: options.jobs ?? [job], error: null }));
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    let operation: "select" | "insert" | "update" = "select";
    const builder: Record<string, any> = {
      select: vi.fn(() => builder),
      eq: vi.fn((key: string, value: unknown) => {
        filters[key] = value;
        return builder;
      }),
      update: vi.fn((patch: Record<string, unknown>) => {
        operation = "update";
        updates.push({ table, patch });
        return builder;
      }),
      insert: vi.fn((row: Record<string, unknown>) => {
        operation = "insert";
        inserts.push({ table, row });
        return builder;
      }),
      maybeSingle: vi.fn(async () => {
        if (table === "wa_messages") return { data: options.existingMessage ?? null, error: null };
        if (table === "wa_guest_portal_sessions") {
          return { data: { expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), revoked_at: null }, error: null };
        }
        if (table === "wa_phone_number_bindings") {
          return { data: { id: job.binding_id, integration_id: "integration-1", phone_number_id: "987654321", status: "active" }, error: null };
        }
        if (table === "api_integrations") {
          return { data: {
            id: "integration-1",
            status: "active",
            provider: "meta-whatsapp",
            channel_key: "whatsapp",
            integration_type: "channel",
            config: { graphApiVersion: "v27.0", wabaId: "123456789" },
          }, error: null };
        }
        if (table === "wa_conversations") {
          return { data: { last_message_at: options.lastMessageAt ?? new Date(Date.now() - 60_000).toISOString() }, error: null };
        }
        if (table === "wa_outbound_jobs") return { data: options.requeueJob ?? null, error: null };
        return { data: null, error: null };
      }),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        const error = operation === "insert" ? options.messageInsertError ?? null : null;
        return Promise.resolve({ error }).then(resolve, reject);
      },
    };
    return builder;
  });
  return { db: { from, rpc }, inserts, updates, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decryptSecret.mockReturnValue("Welcome. Secure menu: https://guest.example.test/guest/private-token");
  mocks.getIntegrationSecret.mockResolvedValue("access-token");
  mocks.sendTextMessage.mockResolvedValue({ messages: [{ id: "wamid.outbound.1" }] });
  mocks.assertCapability.mockResolvedValue(undefined);
  mocks.writeCommercialAudit.mockResolvedValue(undefined);
});

describe("Meta WhatsApp outbound Guest Portal queue", () => {
  it("sends once, stores a redacted message record and marks the job sent", async () => {
    const { db, inserts, updates } = makeDb();

    const result = await processPendingMetaOutboundJobs(db, { workerId: "worker-1" });

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0, uncertain: 0 });
    expect(mocks.sendTextMessage).toHaveBeenCalledWith(
      { accessToken: "access-token", wabaId: "123456789", phoneNumberId: "987654321" },
      "255700000000",
      "Welcome. Secure menu: https://guest.example.test/guest/private-token",
      { graphApiVersion: "v27.0" },
    );
    expect(inserts.find((entry) => entry.table === "wa_messages")?.row).toMatchObject({
      provider_message_id: "wamid.outbound.1",
      outbound_job_id: job.id,
      direction: "outbound",
      status: "sent",
      content: "Welcome. Secure menu: [secure guest link]",
    });
    expect(JSON.stringify(inserts)).not.toContain("private-token");
    expect(updates.find((entry) => entry.table === "wa_outbound_jobs")?.patch).toMatchObject({
      status: "sent",
      provider_message_id: "wamid.outbound.1",
    });
  });

  it("recovers a crash after message persistence without sending twice", async () => {
    const { db, updates } = makeDb({
      existingMessage: { id: "message-1", provider_message_id: "wamid.existing", provider_timestamp: "2026-11-16T20:00:00.000Z" },
    });

    const result = await processPendingMetaOutboundJobs(db);

    expect(result.sent).toBe(1);
    expect(mocks.sendTextMessage).not.toHaveBeenCalled();
    expect(updates.find((entry) => entry.table === "wa_outbound_jobs")?.patch).toMatchObject({
      status: "sent",
      provider_message_id: "wamid.existing",
    });
  });

  it("retries a known Meta rate limit with backoff", async () => {
    mocks.sendTextMessage.mockRejectedValueOnce(
      new (await import("./providers/meta-cloud-api.server")).MetaGraphError("rate limited", 429, 4),
    );
    const { db, updates } = makeDb();

    const result = await processPendingMetaOutboundJobs(db);

    expect(result.retried).toBe(1);
    expect(updates.find((entry) => entry.table === "wa_outbound_jobs")?.patch).toMatchObject({
      status: "retry",
      last_error: "meta_rate_limited",
    });
  });

  it("does not automatically retry an uncertain network delivery outcome", async () => {
    mocks.sendTextMessage.mockRejectedValueOnce(
      new (await import("./providers/meta-cloud-api.server")).MetaGraphError("network timeout", null),
    );
    const { db, updates } = makeDb();

    const result = await processPendingMetaOutboundJobs(db);

    expect(result.uncertain).toBe(1);
    expect(updates.find((entry) => entry.table === "wa_outbound_jobs")?.patch).toMatchObject({
      status: "uncertain",
      last_error: "meta_delivery_outcome_uncertain",
    });
  });

  it("refuses free-form sends outside the 24-hour customer service window", async () => {
    const { db, updates } = makeDb({
      lastMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    const result = await processPendingMetaOutboundJobs(db);

    expect(result.failed).toBe(1);
    expect(mocks.sendTextMessage).not.toHaveBeenCalled();
    expect(updates.find((entry) => entry.table === "wa_outbound_jobs")?.patch).toMatchObject({
      status: "failed",
      last_error: "meta_customer_service_window_expired",
    });
  });

  it("requires explicit operator confirmation before requeueing uncertain delivery", async () => {
    const { db, updates } = makeDb({
      requeueJob: {
        id: job.id,
        tenant_id: job.tenant_id,
        property_id: job.property_id,
        status: "uncertain",
      },
    });

    await expect(requeueMetaOutboundJob(db, db, "user-1", job.id, false)).rejects.toThrow(
      "Explicit confirmation that Meta did not deliver this message is required.",
    );
    expect(updates).toHaveLength(0);

    const result = await requeueMetaOutboundJob(db, db, "user-1", job.id, true);
    expect(result).toEqual({ jobId: job.id, status: "retry" });
    expect(mocks.assertCapability).toHaveBeenCalled();
    expect(mocks.writeCommercialAudit).toHaveBeenCalled();
  });
});
