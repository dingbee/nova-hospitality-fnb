import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveGuestCommerceSession: vi.fn(),
  resolveGuestPaymentTiming: vi.fn(),
  resolveServiceConfiguration: vi.fn(),
  fetchSellableCatalog: vi.fn(),
  createGuestOrder: vi.fn(),
  recalcOrder: vi.fn(),
  fireGuestOrder: vi.fn(),
  pickGuestOrderableLines: vi.fn(),
  resolveGuestTableContext: vi.fn(),
  resolveOrStartGuestSession: vi.fn(),
}));

vi.mock("@/modules/messaging/guest-portal-sessions.server", () => ({
  resolveGuestCommerceSession: mocks.resolveGuestCommerceSession,
}));
vi.mock("@/modules/restaurant/payments/payment-timing", () => ({
  resolveGuestPaymentTiming: mocks.resolveGuestPaymentTiming,
}));
vi.mock("@/modules/restaurant/operations/service-config", () => ({
  resolveServiceConfiguration: mocks.resolveServiceConfiguration,
}));
vi.mock("@/modules/restaurant/sales/pos.server", () => ({
  fetchSellableCatalog: mocks.fetchSellableCatalog,
}));
vi.mock("@/modules/restaurant/sales/sales.server", () => ({
  createGuestOrder: mocks.createGuestOrder,
  recalcOrder: mocks.recalcOrder,
}));
vi.mock("@/modules/restaurant/kitchen/kitchen.server", () => ({
  fireGuestOrder: mocks.fireGuestOrder,
}));
vi.mock("@/modules/restaurant/selforder/selforder.server", () => ({
  pickGuestOrderableLines: mocks.pickGuestOrderableLines,
  resolveGuestTableContext: mocks.resolveGuestTableContext,
  resolveOrStartGuestSession: mocks.resolveOrStartGuestSession,
}));

import { submitGuestCommerceOrder } from "./orders.server";

const session = {
  sessionId: "commerce-session-1",
  tenantId: "tenant-1",
  propertyId: "property-1",
  locationId: "location-1",
  bindingId: null,
  conversationId: null,
  tableId: null,
  sourceChannel: "whatsapp" as const,
  orderType: "takeaway" as const,
  currency: "TZS",
  scope: "guest_commerce",
};
const line = {
  menuItemId: "menu-item-1",
  description: "Pilau",
  quantity: 1,
  unitPrice: 12000,
  discount: 0,
  modifiers: [],
};
const finalOrder = {
  id: "order-1",
  order_number: "ORD-1",
  status: "open",
  payment_state: "unpaid",
  subtotal: 12000,
  tax_total: 0,
  total: 12000,
  paid_total: 0,
  currency: "TZS",
};

function makeAdmin(orderRows: any[] = [null, finalOrder], tenantSettings = { operations: { serviceMode: "takeaway" } }) {
  const from = vi.fn((table: string) => {
    let value: any = null;
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => {
        if (table === "restaurant_tenants") return { data: { id: "tenant-1", status: "active", settings: tenantSettings }, error: null };
        if (table === "restaurant_properties") return { data: { id: "property-1", status: "active", currency: "TZS" }, error: null };
        if (table === "restaurant_orders") {
          value = orderRows.shift() ?? null;
          return { data: value, error: null };
        }
        return { data: null, error: null };
      }),
    };
    return query;
  });
  return { from };
}

describe("unified Guest Commerce order engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveGuestCommerceSession.mockResolvedValue(session);
    mocks.resolveGuestPaymentTiming.mockReturnValue("pay_first");
    mocks.resolveServiceConfiguration.mockReturnValue({ serviceMode: "takeaway" });
    mocks.fetchSellableCatalog.mockResolvedValue({
      items: [{ id: "menu-item-1", is_available: true, priceConfigured: true }],
    });
    mocks.pickGuestOrderableLines.mockImplementation((_ids, lines) => ({ valid: lines, rejected: [] }));
    mocks.createGuestOrder.mockResolvedValue({
      id: "order-1",
      order_number: "ORD-1",
      currency: "TZS",
      status: "open",
      payment_state: "unpaid",
      idempotent: false,
    });
    mocks.recalcOrder.mockResolvedValue({
      subtotal: 12000,
      tax_total: 0,
      total: 12000,
      paid_total: 0,
    });
    mocks.fireGuestOrder.mockResolvedValue({ fired: 1 });
  });

  it("creates a WhatsApp collection order through the canonical guest order writer", async () => {
    const admin = makeAdmin();

    const result = await submitGuestCommerceOrder(admin, {
      token: "a".repeat(43),
      guestName: "Guest",
      lines: [line],
      clientRequestId: "guest-request-001",
    });

    expect(mocks.createGuestOrder).toHaveBeenCalledWith(admin, expect.objectContaining({
      tenantId: "tenant-1",
      propertyId: "property-1",
      locationId: "location-1",
      tableId: null,
      orderType: "takeaway",
      source: "guest_commerce",
      guestCommerceSessionId: "commerce-session-1",
      guestCommerceChannel: "whatsapp",
      guestSessionId: null,
      currency: "TZS",
    }));
    expect(mocks.fetchSellableCatalog).toHaveBeenCalledWith(admin, "tenant-1", {
      propertyId: "property-1",
      locationId: "location-1",
      orderType: "takeaway",
    });
    expect(result).toMatchObject({
      orderId: "order-1",
      orderNumber: "ORD-1",
      orderType: "takeaway",
      channel: "whatsapp",
      total: 12000,
      currency: "TZS",
    });
    expect(mocks.fireGuestOrder).not.toHaveBeenCalled();
  });

  it("fires a table-bound dine-in order under the existing guest dining session", async () => {
    mocks.resolveGuestCommerceSession.mockResolvedValue({
      ...session,
      tableId: "table-1",
      sourceChannel: "qr",
      orderType: "dine_in",
    });
    mocks.resolveServiceConfiguration.mockReturnValue({ serviceMode: "table_service" });
    mocks.resolveGuestPaymentTiming.mockReturnValue("pay_after_service");
    mocks.resolveGuestTableContext.mockResolvedValue({
      tenantId: "tenant-1",
      propertyId: "property-1",
      locationId: "location-1",
      tableId: "table-1",
      currency: "TZS",
      guestPaymentTiming: "pay_after_service",
    });
    mocks.resolveOrStartGuestSession.mockResolvedValue({ sessionId: "dining-session-1", token: "", created: false });
    const admin = makeAdmin();

    await submitGuestCommerceOrder(admin, {
      token: "b".repeat(43),
      lines: [line],
      clientRequestId: "guest-request-002",
    });

    expect(mocks.createGuestOrder).toHaveBeenCalledWith(admin, expect.objectContaining({
      tableId: "table-1",
      orderType: "dine_in",
      guestSessionId: "dining-session-1",
      guestCommerceChannel: "qr",
    }));
    expect(mocks.fireGuestOrder).toHaveBeenCalledWith(admin, { tenantId: "tenant-1", orderId: "order-1" });
  });

  it("rejects table-service checkout without a table-bound QR session", async () => {
    mocks.resolveGuestCommerceSession.mockResolvedValue({
      ...session,
      sourceChannel: "website",
      orderType: "dine_in",
    });
    mocks.resolveServiceConfiguration.mockReturnValue({ serviceMode: "table_service" });

    await expect(submitGuestCommerceOrder(makeAdmin(), {
      token: "c".repeat(43),
      lines: [line],
      clientRequestId: "guest-request-003",
    })).rejects.toThrow(/table QR code/i);
    expect(mocks.createGuestOrder).not.toHaveBeenCalled();
  });

  it("rejects stale property currency before reading the sellable catalogue", async () => {
    const admin = makeAdmin();
    admin.from = vi.fn((table: string) => {
      const query: any = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => {
          if (table === "restaurant_tenants") return { data: { id: "tenant-1", status: "active", settings: {} }, error: null };
          if (table === "restaurant_properties") return { data: { id: "property-1", status: "active", currency: "USD" }, error: null };
          return { data: null, error: null };
        }),
      };
      return query;
    });

    await expect(submitGuestCommerceOrder(admin, {
      token: "d".repeat(43),
      lines: [line],
      clientRequestId: "guest-request-004",
    })).rejects.toThrow(/currency/i);
    expect(mocks.fetchSellableCatalog).not.toHaveBeenCalled();
  });

  it("returns the existing order only when the idempotency key belongs to this session", async () => {
    const existing = {
      ...finalOrder,
      guest_commerce_session_id: "commerce-session-1",
      guest_commerce_channel: "whatsapp",
      order_type: "takeaway",
    };

    const result = await submitGuestCommerceOrder(makeAdmin([existing]), {
      token: "e".repeat(43),
      lines: [line],
      clientRequestId: "guest-request-005",
    });

    expect(result).toMatchObject({ orderId: "order-1", orderNumber: "ORD-1", idempotent: true });
    expect(mocks.createGuestOrder).not.toHaveBeenCalled();
    expect(mocks.fetchSellableCatalog).not.toHaveBeenCalled();
  });

  it("rejects an idempotency key already owned by another guest session", async () => {
    const existing = {
      ...finalOrder,
      guest_commerce_session_id: "another-session",
      guest_commerce_channel: "whatsapp",
      order_type: "takeaway",
    };

    await expect(submitGuestCommerceOrder(makeAdmin([existing]), {
      token: "f".repeat(43),
      lines: [line],
      clientRequestId: "guest-request-006",
    })).rejects.toThrow(/already been used/i);
    expect(mocks.createGuestOrder).not.toHaveBeenCalled();
  });
});
