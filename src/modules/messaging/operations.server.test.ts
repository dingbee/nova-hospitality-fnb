import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCapability,
  assertTenantRead,
  getTenantScope,
} from "@/modules/restaurant/core/access.server";
import { assertCommercialAdmin } from "@/modules/commercial/access.server";
import {
  getFounderWhatsAppOverview,
  getWhatsAppConversionReport,
  listWhatsAppInbox,
  listWhatsAppGuestCRM,
} from "./operations.server";

vi.mock("@/modules/restaurant/core/access.server", () => ({
  accessiblePropertyIds: vi.fn(() => ["property-1"]),
  assertCapability: vi.fn(),
  assertTenantRead: vi.fn(),
  getTenantScope: vi.fn(async () => ({
    tenantId: "tenant-1",
    platformAdmin: false,
    grants: [{ role: "owner", propertyId: "property-1" }],
  })),
}));

vi.mock("@/modules/commercial/access.server", () => ({
  assertCommercialAdmin: vi.fn(),
}));

describe("WhatsApp operations authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTenantScope).mockResolvedValue({
      tenantId: "tenant-1",
      platformAdmin: false,
      grants: [{ role: "owner", propertyId: "property-1" }],
    });
  });

  it("requires founder commercial-admin authorization before platform-wide reads", async () => {
    vi.mocked(assertCommercialAdmin).mockRejectedValueOnce(new Error("commercial admin required"));
    await expect(getFounderWhatsAppOverview({}, "tenant-owner")).rejects.toThrow(
      "commercial admin required",
    );
    expect(assertCommercialAdmin).toHaveBeenCalledWith({}, "tenant-owner");
  });

  it("rejects tenant inbox reads before querying when tenant membership is absent", async () => {
    vi.mocked(assertTenantRead).mockRejectedValueOnce(new Error("tenant membership required"));
    const db = { from: vi.fn() };
    await expect(listWhatsAppInbox(db, "outside-user", { tenantId: "tenant-1" })).rejects.toThrow(
      "tenant membership required",
    );
    expect(db.from).not.toHaveBeenCalled();
  });

  it("checks guest-read capability before exposing CRM data", async () => {
    vi.mocked(assertCapability).mockRejectedValueOnce(new Error("guest read required"));
    const db = { from: vi.fn() };
    await expect(
      listWhatsAppGuestCRM(db, "read-only-user", { tenantId: "tenant-1" }),
    ).rejects.toThrow("guest read required");
    expect(db.from).not.toHaveBeenCalled();
  });
  it("does not let platform-admin status substitute for tenant membership on tenant APIs", async () => {
    vi.mocked(getTenantScope).mockResolvedValue({
      tenantId: "tenant-1",
      platformAdmin: true,
      grants: [],
    });
    const db = { from: vi.fn() };
    await expect(listWhatsAppInbox(db, "platform-admin", { tenantId: "tenant-1" })).rejects.toThrow(
      "tenant_membership_required",
    );
    expect(db.from).not.toHaveBeenCalled();
  });
});

describe("WCE-08 WhatsApp-to-commerce conversion reconciliation", () => {
  it("counts converted sessions rather than orders when one session places multiple orders", async () => {
    const datasets: Record<string, unknown[]> = {
      wa_guest_portal_sessions: [
        { id: "session-1", opened_at: "2026-11-18T07:00:00.000Z", created_at: "2026-11-18T06:59:00.000Z" },
        { id: "session-2", opened_at: null, created_at: "2026-11-18T07:10:00.000Z" },
      ],
      restaurant_orders: [
        { id: "order-1", guest_portal_session_id: "session-1", payment_state: "paid", total: 100, currency: "TZS", opened_at: "2026-11-18T07:05:00.000Z" },
        { id: "order-2", guest_portal_session_id: "session-1", payment_state: "pending", total: 50, currency: "TZS", opened_at: "2026-11-18T07:06:00.000Z" },
        { id: "order-3", guest_portal_session_id: "session-2", payment_state: "paid", total: 999, currency: "TZS", opened_at: "2026-11-18T07:11:00.000Z" },
      ],
    };
    const queryCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
    const db = {
      from: (table: string) => {
        const builder: any = {
          select: (...args: unknown[]) => { queryCalls.push({ table, method: "select", args }); return builder; },
          eq: (...args: unknown[]) => { queryCalls.push({ table, method: "eq", args }); return builder; },
          not: (...args: unknown[]) => { queryCalls.push({ table, method: "not", args }); return builder; },
          order: (...args: unknown[]) => { queryCalls.push({ table, method: "order", args }); return builder; },
          limit: (...args: unknown[]) => { queryCalls.push({ table, method: "limit", args }); return builder; },
          in: (...args: unknown[]) => { queryCalls.push({ table, method: "in", args }); return builder; },
          gte: (...args: unknown[]) => { queryCalls.push({ table, method: "gte", args }); return builder; },
          lte: (...args: unknown[]) => { queryCalls.push({ table, method: "lte", args }); return builder; },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({ data: datasets[table] ?? [], error: null }).then(resolve, reject),
        };
        return builder;
      },
    };
    const result = await getWhatsAppConversionReport(db, "tenant-owner", {
      tenantId: "tenant-1",
      propertyId: "property-1",
    });
    expect(result).toMatchObject({
      sessionsCreated: 2,
      sessionsOpened: 1,
      sessionsWithOrders: 1,
      ordersPlaced: 2,
      ordersPaid: 1,
      sessionToOrderRate: 1,
      orderToPaidRate: 0.5,
      paidRevenueByCurrency: [{ currency: "TZS", amount: 100 }],
    });
    expect(queryCalls).toContainEqual({ table: "wa_guest_portal_sessions", method: "eq", args: ["tenant_id", "tenant-1"] });
    expect(queryCalls).toContainEqual({ table: "restaurant_orders", method: "eq", args: ["tenant_id", "tenant-1"] });
    expect(queryCalls).toContainEqual({ table: "wa_guest_portal_sessions", method: "in", args: ["property_id", ["property-1"]] });
    expect(queryCalls).toContainEqual({ table: "restaurant_orders", method: "in", args: ["property_id", ["property-1"]] });
  });
});

