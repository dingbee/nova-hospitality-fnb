/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double mirrors untyped query builders. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  fetchSellableCatalog: vi.fn(),
}));

vi.mock("@/modules/messaging/guest-portal-sessions.server", () => ({
  resolveWhatsAppGuestPortalSession: mocks.resolveSession,
}));
vi.mock("../sales/pos.server", () => ({
  fetchSellableCatalog: mocks.fetchSellableCatalog,
}));

import { getWhatsAppGuestPortalPage } from "./whatsapp-guest-portal.server";

beforeEach(() => vi.clearAllMocks());

const session = {
  sessionId: "session-internal",
  tenantId: "tenant-internal",
  propertyId: "property-internal",
  locationId: "outlet-internal",
  bindingId: "binding-internal",
  currency: "TZS",
  expiresAt: "2026-11-16T22:00:00.000Z",
};

function makeAdmin(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = {
    restaurant_tenants: {
      id: session.tenantId,
      name: "Tenant Legal Name",
      status: "active",
      settings: { business: { tradingName: "The Restaurant", logoUrl: "https://cdn.example.test/logo.png" } },
    },
    restaurant_properties: {
      id: session.propertyId,
      name: "Dar Property",
      currency: "TZS",
    },
    restaurant_locations: {
      id: session.locationId,
      name: "City Centre",
      location_type: "outlet",
      is_storage: false,
      status: "active",
    },
    wa_phone_number_bindings: {
      display_phone_number: "+255700000000",
      verified_name: "The Restaurant",
      status: "active",
    },
    ...overrides,
  };
  const from = vi.fn((table: string) => {
    const builder: Record<string, any> = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({ data: rows[table] ?? null, error: null })),
    };
    return builder;
  });
  return { from };
}

describe("WhatsApp Guest Portal page read model", () => {
  it("returns branded menu context without serializing internal tenant/property/session IDs", async () => {
    mocks.resolveSession.mockResolvedValue(session);
    mocks.fetchSellableCatalog.mockResolvedValue({
      categories: [{ id: "category-1", name: "Mains" }],
      items: [
        { id: "item-1", name: "Pilau", price: 12000, currency: "TZS", available: true, priceConfigured: true },
        { id: "item-2", name: "Hidden", price: null, available: false, priceConfigured: false },
      ],
    });

    const result = await getWhatsAppGuestPortalPage(makeAdmin(), "a".repeat(43));

    expect(result).toMatchObject({
      businessName: "The Restaurant",
      businessLogoUrl: "https://cdn.example.test/logo.png",
      propertyName: "Dar Property",
      outletName: "City Centre",
      currency: "TZS",
      supportPhone: "+255700000000",
      categories: [{ id: "category-1", name: "Mains" }],
      items: [{ id: "item-1", name: "Pilau", price: 12000 }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(session.tenantId);
    expect(serialized).not.toContain(session.propertyId);
    expect(serialized).not.toContain(session.locationId);
    expect(serialized).not.toContain(session.sessionId);
    expect(serialized).not.toContain("a".repeat(43));
    expect(mocks.fetchSellableCatalog).toHaveBeenCalledWith(
      expect.anything(),
      session.tenantId,
      { propertyId: session.propertyId, locationId: session.locationId },
    );
  });

  it("rejects expired or invalid session tokens before querying tenant data", async () => {
    mocks.resolveSession.mockResolvedValue(null);
    const admin = makeAdmin();

    await expect(getWhatsAppGuestPortalPage(admin, "a".repeat(43))).rejects.toThrow(
      "This Guest Portal link has expired or is no longer valid.",
    );
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("rejects a stale currency context rather than falling back to another currency", async () => {
    mocks.resolveSession.mockResolvedValue(session);
    mocks.fetchSellableCatalog.mockResolvedValue({ categories: [], items: [] });
    const admin = makeAdmin({
      restaurant_properties: { id: session.propertyId, name: "Dar Property", currency: "USD" },
    });

    await expect(getWhatsAppGuestPortalPage(admin, "a".repeat(43))).rejects.toThrow(
      "This restaurant ordering link is no longer available.",
    );
    expect(mocks.fetchSellableCatalog).not.toHaveBeenCalled();
  });
});
