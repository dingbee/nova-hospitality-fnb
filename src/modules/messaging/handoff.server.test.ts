/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double mirrors untyped query builders. */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  encryptSecret: vi.fn(),
  createWhatsAppGuestPortalSession: vi.fn(),
}));

vi.mock("@/modules/api-platform/crypto.server", () => ({
  encryptSecret: mocks.encryptSecret,
}));
vi.mock("@/modules/messaging/guest-portal-sessions.server", () => ({
  createWhatsAppGuestPortalSession: mocks.createWhatsAppGuestPortalSession,
}));

import { enqueueWhatsAppGuestPortalHandoff } from "./handoff.server";

const event = {
  id: "event-1",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  property_id: "22222222-2222-4222-8222-222222222222",
  location_id: "33333333-3333-4333-8333-333333333333",
  binding_id: "44444444-4444-4444-8444-444444444444",
};

function makeDb(options: {
  eventJob?: Record<string, any> | null;
  latestJob?: Record<string, any> | null;
  previousSession?: Record<string, any> | null;
  insertError?: { code: string } | null;
} = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, any> = {
      select: vi.fn(() => builder),
      eq: vi.fn((key: string, value: unknown) => {
        filters[key] = value;
        return builder;
      }),
      in: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => {
        if (table === "wa_outbound_jobs") {
          return {
            data: filters.source_event_id ? options.eventJob ?? null : options.latestJob ?? null,
            error: null,
          };
        }
        if (table === "wa_guest_portal_sessions") return { data: options.previousSession ?? null, error: null };
        if (table === "restaurant_tenants") {
          return { data: { name: "Tenant Name", status: "active", settings: { business: { tradingName: "Restaurant" } } }, error: null };
        }
        if (table === "restaurant_locations") {
          return { data: { name: "City Outlet", status: "active", location_type: "outlet", is_storage: false }, error: null };
        }
        return { data: null, error: null };
      }),
      insert: vi.fn((row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return builder;
      }),
      update: vi.fn((patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        return builder;
      }),
      single: vi.fn(async () => ({
        data: { id: "job-1" },
        error: options.insertError ?? null,
      })),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(resolve, reject),
    };
    return builder;
  });
  return { admin: { from, rpc }, inserts, updates, rpc };
}

afterEach(() => vi.clearAllMocks());

describe("WhatsApp Guest Portal handoff enqueue", () => {
  it("stores an encrypted, event-idempotent link job without plaintext token", async () => {
    mocks.createWhatsAppGuestPortalSession.mockResolvedValue({
      sessionId: "session-1",
      portalUrl: "https://guest.example.test/guest/secret-token",
    });
    mocks.encryptSecret.mockReturnValue({ ciphertext: "ciphertext", iv: "iv", tag: "tag" });
    const { admin, inserts } = makeDb();

    const result = await enqueueWhatsAppGuestPortalHandoff(admin, event, "conversation-1", "255700000000");

    expect(result).toMatchObject({ queued: true, jobId: "job-1", sessionId: "session-1" });
    const job = inserts.find((entry) => entry.table === "wa_outbound_jobs")?.row;
    expect(job).toMatchObject({
      tenant_id: event.tenant_id,
      property_id: event.property_id,
      location_id: event.location_id,
      binding_id: event.binding_id,
      conversation_id: "conversation-1",
      source_event_id: event.id,
      portal_session_id: "session-1",
      recipient_phone: "255700000000",
      idempotency_key: "event-1:conversation-1",
      body_ciphertext: "ciphertext",
      body_iv: "iv",
      body_tag: "tag",
      status: "pending",
    });
    expect(job).not.toHaveProperty("body");
    expect(mocks.encryptSecret).toHaveBeenCalledWith(
      expect.stringContaining("https://guest.example.test/guest/secret-token"),
    );
  });

  it("does not create a second link while a conversation already has a pending job", async () => {
    const { admin, inserts } = makeDb({
      latestJob: { id: "job-existing", status: "pending", portal_session_id: "session-existing" },
    });

    const result = await enqueueWhatsAppGuestPortalHandoff(admin, event, "conversation-1", "255700000000");

    expect(result).toMatchObject({ queued: false, reason: "conversation_has_active_handoff" });
    expect(mocks.createWhatsAppGuestPortalSession).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("does not reissue a sent event when that webhook is replayed", async () => {
    const { admin, inserts } = makeDb({
      eventJob: { id: "job-existing", status: "sent", portal_session_id: "session-existing" },
    });

    const result = await enqueueWhatsAppGuestPortalHandoff(admin, event, "conversation-1", "255700000000");

    expect(result).toMatchObject({ queued: false, reason: "handoff_already_pending_or_active" });
    expect(mocks.createWhatsAppGuestPortalSession).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("requeues a failed event job with a fresh session and encrypted body", async () => {
    mocks.createWhatsAppGuestPortalSession.mockResolvedValue({
      sessionId: "session-new",
      portalUrl: "https://guest.example.test/guest/new-token",
    });
    mocks.encryptSecret.mockReturnValue({ ciphertext: "new-cipher", iv: "new-iv", tag: "new-tag" });
    const { admin, updates } = makeDb({
      eventJob: { id: "job-failed", status: "failed", portal_session_id: "session-old" },
    });

    const result = await enqueueWhatsAppGuestPortalHandoff(admin, event, "conversation-1", "255700000000");

    expect(result).toMatchObject({ queued: true, jobId: "job-failed", sessionId: "session-new" });
    expect(updates.find((entry) => entry.table === "wa_outbound_jobs")?.patch).toMatchObject({
      portal_session_id: "session-new",
      status: "pending",
      attempt_count: 0,
      body_ciphertext: "new-cipher",
    });
  });
});
