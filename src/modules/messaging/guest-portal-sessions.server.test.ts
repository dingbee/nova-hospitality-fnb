/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double mirrors untyped query builders. */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWhatsAppGuestPortalSession,
  resolveWhatsAppGuestPortalSession,
  revokeWhatsAppGuestPortalSession,
} from "./guest-portal-sessions.server";

const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  propertyId: "22222222-2222-4222-8222-222222222222",
  locationId: "33333333-3333-4333-8333-333333333333",
  bindingId: "44444444-4444-4444-8444-444444444444",
  conversationId: "55555555-5555-4555-8555-555555555555",
  createdByEventId: "66666666-6666-4666-8666-666666666666",
};

function makeAdmin(overrides: Record<string, unknown> = {}) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const rows: Record<string, unknown> = {
    restaurant_tenants: { id: scope.tenantId, status: "active", settings: { operations: { serviceMode: "takeaway" } } },
    wa_phone_number_bindings: {
      id: scope.bindingId,
      tenant_id: scope.tenantId,
      property_id: scope.propertyId,
      location_id: scope.locationId,
      integration_id: "77777777-7777-4777-8777-777777777777",
      status: "active",
    },
    api_integrations: { id: "77777777-7777-4777-8777-777777777777", status: "active" },
    wa_conversations: {
      id: scope.conversationId,
      binding_id: scope.bindingId,
      tenant_id: scope.tenantId,
      property_id: scope.propertyId,
      location_id: scope.locationId,
      status: "open",
    },
    wa_webhook_events: {
      id: scope.createdByEventId,
      status: "processing",
      binding_id: scope.bindingId,
      tenant_id: scope.tenantId,
      property_id: scope.propertyId,
      location_id: scope.locationId,
    },
    restaurant_locations: {
      id: scope.locationId,
      tenant_id: scope.tenantId,
      property_id: scope.propertyId,
      location_type: "restaurant",
      is_storage: false,
      status: "active",
    },
    restaurant_properties: { currency: "TZS", status: "active" },
    ...overrides,
  };
  const from = vi.fn((table: string) => {
    const builder: Record<string, any> = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      is: vi.fn(() => builder),
      gt: vi.fn(() => builder),
      update: vi.fn(() => builder),
      insert: vi.fn((row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return builder;
      }),
      maybeSingle: vi.fn(async () => ({ data: rows[table] ?? null, error: null })),
      single: vi.fn(async () => ({ data: { id: "session-1" }, error: null })),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(resolve, reject),
    };
    return builder;
  });
  const rpc = vi.fn(async (..._args: unknown[]): Promise<{ data: unknown; error: unknown }> => ({ data: true, error: null }));
  return { admin: { from, rpc }, inserted, rpc };
}

afterEach(() => vi.unstubAllEnvs());

describe("WhatsApp Guest Portal session security", () => {
  it("creates a 256-bit browse-only session and stores only its SHA-256 hash", async () => {
    vi.stubEnv("LEXIBITE_GUEST_PORTAL_BASE_URL", "https://guest.example.test");
    const { admin, inserted } = makeAdmin();

    const result = await createWhatsAppGuestPortalSession(admin, scope);

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.portalUrl).toBe(`https://guest.example.test/guest/${result.token}`);
    expect(result.scope).toBe("guest_commerce");
    expect(result.currency).toBe("TZS");

    const row = inserted.find((entry) => entry.table === "restaurant_guest_commerce_sessions")?.row;
    expect(row).toMatchObject({
      tenant_id: scope.tenantId,
      property_id: scope.propertyId,
      location_id: scope.locationId,
      binding_id: scope.bindingId,
      conversation_id: scope.conversationId,
      scope: "guest_commerce",
      source_channel: "whatsapp",
      order_type: "takeaway",
      currency: "TZS",
      max_open_count: 20,
    });
    expect(row?.token_hash).toBe(createHash("sha256").update(result.token).digest("hex"));
    expect(row).not.toHaveProperty("token");
    expect(result.portalUrl).not.toContain(scope.tenantId);
    expect(result.portalUrl).not.toContain(scope.propertyId);
  });

  it("does not create a session for an inactive receiving-number binding", async () => {
    vi.stubEnv("LEXIBITE_GUEST_PORTAL_BASE_URL", "https://guest.example.test");
    const { admin, inserted } = makeAdmin({
      wa_phone_number_bindings: {
        id: scope.bindingId,
        tenant_id: scope.tenantId,
        property_id: scope.propertyId,
        location_id: scope.locationId,
        integration_id: "77777777-7777-4777-8777-777777777777",
        status: "disabled",
      },
    });

    await expect(createWhatsAppGuestPortalSession(admin, scope)).rejects.toThrow(
      "An active WhatsApp receiving-number binding is required.",
    );
    expect(inserted).toHaveLength(0);
  });

  it("atomically resolves a token through the service-only RPC and returns scoped context", async () => {
    const token = "a".repeat(43);
    const { admin, rpc } = makeAdmin();
    rpc.mockResolvedValueOnce({
      data: [{
        session_id: "session-1",
        tenant_id: scope.tenantId,
        property_id: scope.propertyId,
        location_id: scope.locationId,
        binding_id: scope.bindingId,
        conversation_id: scope.conversationId,
        currency: "TZS",
        menu_context: {},
        expires_at: "2026-11-16T21:00:00.000Z",
        scope: "menu_browse",
      }],
      error: null,
    });

    const result = await resolveWhatsAppGuestPortalSession(admin, token);

    expect(rpc).toHaveBeenCalledWith("restaurant_resolve_guest_commerce_session", {
      _token_hash: createHash("sha256").update(token).digest("hex"),
    });
    expect(result).toMatchObject({
      sessionId: "session-1",
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      locationId: scope.locationId,
      scope: "guest_commerce",
      sourceChannel: "whatsapp",
      orderType: "takeaway",
      tableId: null,
    });
  });

  it("rejects malformed tokens without a database call and supports revocation", async () => {
    const { admin, rpc } = makeAdmin();
    expect(await resolveWhatsAppGuestPortalSession(admin, "short-token")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();

    expect(await revokeWhatsAppGuestPortalSession(admin, "session-1")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("restaurant_revoke_guest_commerce_session", {
      _session_id: "session-1",
    });
  });
});
