/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase query builder in the integration test. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCapability,
  assertTenantRead,
  getTenantScope,
} from "@/modules/restaurant/core/access.server";
import { assertCommercialAdmin } from "@/modules/commercial/access.server";
import { checkQuota } from "@/modules/commercial/quota.server";

const { supabaseAdminMock } = vi.hoisted(() => ({
  supabaseAdminMock: { from: vi.fn() },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: supabaseAdminMock,
}));
import {
  getFounderWhatsAppOverview,
  getWhatsAppConversionReport,
  getWhatsAppUsageReport,
  listWhatsAppInbox,
  listWhatsAppGuestCRM,
  validateWhatsAppTemplateDraftComponents,
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

vi.mock("@/modules/commercial/quota.server", () => ({
  checkQuota: vi.fn(async () => ({
    quotaCode: "whatsapp_campaign_messages",
    unit: "messages",
    limitValue: 500,
    usedValue: 120,
    period: "monthly",
    periodStart: "2026-11-01T00:00:00.000Z",
    periodEnd: "2026-12-01T00:00:00.000Z",
    state: "NORMAL",
    hasOverride: false,
  })),
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
    vi.mocked(getTenantScope).mockResolvedValue({
      tenantId: "tenant-1",
      platformAdmin: false,
      grants: [{ role: "owner", propertyId: "property-1" }],
    });
    const datasets: Record<string, unknown[]> = {
      wa_guest_portal_sessions: [
        {
          id: "session-1",
          opened_at: "2026-11-18T07:00:00.000Z",
          created_at: "2026-11-18T06:59:00.000Z",
        },
        { id: "session-2", opened_at: null, created_at: "2026-11-18T07:10:00.000Z" },
      ],
      restaurant_orders: [
        {
          id: "order-1",
          guest_portal_session_id: "session-1",
          payment_state: "paid",
          total: 100,
          currency: "TZS",
          opened_at: "2026-11-18T07:05:00.000Z",
        },
        {
          id: "order-2",
          guest_portal_session_id: "session-1",
          payment_state: "pending",
          total: 50,
          currency: "TZS",
          opened_at: "2026-11-18T07:06:00.000Z",
        },
        {
          id: "order-3",
          guest_portal_session_id: "session-2",
          payment_state: "paid",
          total: 999,
          currency: "TZS",
          opened_at: "2026-11-18T07:11:00.000Z",
        },
      ],
    };
    const queryCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
    const db = {
      from: (table: string) => {
        const builder: any = {
          select: (...args: unknown[]) => {
            queryCalls.push({ table, method: "select", args });
            return builder;
          },
          eq: (...args: unknown[]) => {
            queryCalls.push({ table, method: "eq", args });
            return builder;
          },
          not: (...args: unknown[]) => {
            queryCalls.push({ table, method: "not", args });
            return builder;
          },
          order: (...args: unknown[]) => {
            queryCalls.push({ table, method: "order", args });
            return builder;
          },
          limit: (...args: unknown[]) => {
            queryCalls.push({ table, method: "limit", args });
            return builder;
          },
          in: (...args: unknown[]) => {
            queryCalls.push({ table, method: "in", args });
            return builder;
          },
          gte: (...args: unknown[]) => {
            queryCalls.push({ table, method: "gte", args });
            return builder;
          },
          lte: (...args: unknown[]) => {
            queryCalls.push({ table, method: "lte", args });
            return builder;
          },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({ data: datasets[table] ?? [], error: null }).then(resolve, reject),
        };
        return builder;
      },
    };
    supabaseAdminMock.from.mockImplementation(db.from);
    const authDb = { from: vi.fn() };
    const result = await getWhatsAppConversionReport(authDb, "tenant-owner", {
      tenantId: "tenant-1",
      propertyId: "property-1",
    });
    expect(authDb.from).not.toHaveBeenCalled();
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
    expect(queryCalls).toContainEqual({
      table: "wa_guest_portal_sessions",
      method: "eq",
      args: ["tenant_id", "tenant-1"],
    });
    expect(queryCalls).toContainEqual({
      table: "restaurant_orders",
      method: "eq",
      args: ["tenant_id", "tenant-1"],
    });
    expect(queryCalls).toContainEqual({
      table: "wa_guest_portal_sessions",
      method: "in",
      args: ["property_id", ["property-1"]],
    });
    expect(queryCalls).toContainEqual({
      table: "restaurant_orders",
      method: "in",
      args: ["property_id", ["property-1"]],
    });
  });
});

describe("WCE-08 WhatsApp usage attribution", () => {
  it("combines provider ledger costs with WhatsApp-scoped concierge AI cost records", async () => {
    vi.mocked(getTenantScope).mockResolvedValue({
      tenantId: "tenant-1",
      platformAdmin: false,
      grants: [{ role: "owner", propertyId: "property-1" }],
    });
    const datasets: Record<string, unknown[]> = {
      wa_campaign_usage_ledger: [
        {
          id: "meta-1",
          usage_component: "meta_provider",
          usage_event: "template_message",
          quantity: 2,
          amount: 0.1,
          currency: "USD",
          recorded_at: "2026-11-18T07:00:00.000Z",
        },
      ],
      commercial_ai_usage_log: [
        {
          id: "ai-1",
          workload_type: "ai_concierge.reply",
          request_count: 3,
          estimated_cost: 0,
          estimated_cost_known: false,
          currency: "USD",
          occurred_at: "2026-11-18T07:01:00.000Z",
        },
        {
          id: "ai-2",
          workload_type: "ai_concierge.reply",
          request_count: 1,
          estimated_cost: 0.04,
          estimated_cost_known: true,
          currency: "USD",
          occurred_at: "2026-11-18T07:02:00.000Z",
        },
      ],
    };
    const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
    const db = {
      from: (table: string) => {
        const builder: any = {
          select: (...args: unknown[]) => {
            calls.push({ table, method: "select", args });
            return builder;
          },
          eq: (...args: unknown[]) => {
            calls.push({ table, method: "eq", args });
            return builder;
          },
          in: (...args: unknown[]) => {
            calls.push({ table, method: "in", args });
            return builder;
          },
          order: (...args: unknown[]) => {
            calls.push({ table, method: "order", args });
            return builder;
          },
          limit: (...args: unknown[]) => {
            calls.push({ table, method: "limit", args });
            return builder;
          },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({ data: datasets[table] ?? [], error: null }).then(resolve, reject),
        };
        return builder;
      },
    };
    const result = await getWhatsAppUsageReport(db, "tenant-owner", {
      tenantId: "tenant-1",
      propertyId: "property-1",
      locationId: "location-1",
    });
    expect(result.totals).toEqual([
      {
        component: "meta_provider",
        currency: "USD",
        amount: 0.1,
        quantity: 2,
        entries: 1,
        unpricedEntries: 0,
        costComplete: true,
      },
      {
        component: "ai",
        currency: "USD",
        amount: 0.04,
        quantity: 4,
        entries: 2,
        unpricedEntries: 1,
        costComplete: false,
      },
    ]);
    expect(result.lexibiteQuota).toMatchObject({
      usedValue: 120,
      limitValue: 500,
      unit: "messages",
      state: "NORMAL",
    });
    expect(checkQuota).toHaveBeenCalledWith(
      db,
      "tenant-1",
      "whatsapp_campaign_messages",
      "property-1",
    );
    expect(calls).toContainEqual({
      table: "commercial_ai_usage_log",
      method: "eq",
      args: ["source_channel", "whatsapp"],
    });
    expect(calls).toContainEqual({
      table: "wa_campaign_usage_ledger",
      method: "eq",
      args: ["location_id", "location-1"],
    });
    expect(calls).toContainEqual({
      table: "commercial_ai_usage_log",
      method: "eq",
      args: ["location_id", "location-1"],
    });
    expect(result.entries).toHaveLength(3);
    expect(result.entries.find((entry: any) => entry.id === "ai-1")).toMatchObject({
      amount: null,
      costKnown: false,
    });
  });
});

describe("WCE-08 guest CRM history and template authoring", () => {
  it("validates one BODY component and rejects malformed template placeholders", () => {
    expect(
      validateWhatsAppTemplateDraftComponents([
        { type: "BODY", text: "Hello {{1}}, your order is ready." },
      ]),
    ).toEqual([{ type: "BODY", text: "Hello {{1}}, your order is ready." }]);
    expect(() =>
      validateWhatsAppTemplateDraftComponents([{ type: "BODY", text: "Hello {{name}}" }]),
    ).toThrow("whatsapp_template_body_invalid");
    expect(() =>
      validateWhatsAppTemplateDraftComponents([{ type: "FOOTER", text: "No body" }]),
    ).toThrow("whatsapp_template_body_required");
    expect(() =>
      validateWhatsAppTemplateDraftComponents([{ type: "BODY", text: "x".repeat(1025) }]),
    ).toThrow("whatsapp_template_body_invalid");
  });

  it("retrieves ten recent orders per guest even when one guest dominates the newest global page", async () => {
    vi.mocked(getTenantScope).mockResolvedValue({
      tenantId: "tenant-1",
      platformAdmin: false,
      grants: [{ role: "owner", propertyId: "property-1" }],
    });
    const orders = [
      ...Array.from({ length: 500 }, (_, index) => ({
        id: "guest-a-order-" + index,
        guest_customer_id: "guest-a",
        property_id: "property-1",
        order_number: "A-" + index,
        order_type: "dine_in",
        status: "closed",
        total: 100,
        currency: "TZS",
        opened_at: new Date(Date.UTC(2026, 10, 19, 12, 0, 0) - index * 1000).toISOString(),
        closed_at: null,
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        id: "guest-b-order-" + index,
        guest_customer_id: "guest-b",
        property_id: "property-1",
        order_number: "B-" + index,
        order_type: "takeaway",
        status: "closed",
        total: 200,
        currency: "TZS",
        opened_at: new Date(Date.UTC(2026, 10, 18, 12, 0, 0) - index * 1000).toISOString(),
        closed_at: null,
      })),
    ];
    const ranges: Array<[number, number]> = [];
    const loyaltyScopeCalls: Array<[string, unknown]> = [];
    const consentScopeCalls: Array<[string, unknown]> = [];
    const datasets: Record<string, unknown[]> = {
      restaurant_guest_customers: [
        { id: "guest-a", display_name: "Guest A" },
        { id: "guest-b", display_name: "Guest B" },
      ],
      restaurant_guest_customer_consents: [],
      restaurant_guest_loyalty_ledger: [],
      restaurant_order_items: [],
    };
    const db = {
      from: (table: string) => {
        let start = 0;
        let end = Number.MAX_SAFE_INTEGER;
        const builder: any = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            if (table === "restaurant_guest_loyalty_ledger") loyaltyScopeCalls.push([column, value]);
            if (table === "restaurant_guest_customer_consents") consentScopeCalls.push([column, value]);
            return builder;
          },
          in: (column: string, value: unknown) => {
            if (table === "restaurant_guest_loyalty_ledger") loyaltyScopeCalls.push([column, value]);
            return builder;
          },
          or: () => builder,
          order: () => builder,
          limit: () => builder,
          range: (from: number, to: number) => {
            start = from;
            end = to;
            ranges.push([from, to]);
            return builder;
          },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({
              data:
                table === "restaurant_orders"
                  ? orders.slice(start, end + 1)
                  : (datasets[table] ?? []),
              error: null,
            }).then(resolve, reject),
        };
        return builder;
      },
    };
    const result = await listWhatsAppGuestCRM(db, "tenant-owner", {
      tenantId: "tenant-1",
      propertyId: "property-1",
    });
    expect(result.find((guest: any) => guest.id === "guest-a")?.recentOrders).toHaveLength(10);
    expect(result.find((guest: any) => guest.id === "guest-b")?.recentOrders).toHaveLength(10);
    expect(ranges).toEqual([
      [0, 499],
      [500, 999],
    ]);
    expect(loyaltyScopeCalls).toContainEqual(["tenant_id", "tenant-1"]);
    expect(loyaltyScopeCalls).toContainEqual(["guest_customer_id", ["guest-a", "guest-b"]]);
    expect(loyaltyScopeCalls).toContainEqual(["property_id", "property-1"]);
    expect(consentScopeCalls).toContainEqual(["tenant_id", "tenant-1"]);
    expect(consentScopeCalls).toContainEqual(["property_id", "property-1"]);
  });
});
