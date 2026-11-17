/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { guestStaffRequestStatus, requestStaff } from "./selfstaff.server";

/**
 * In-memory Supabase stand-in covering the chains selfstaff.server uses:
 * .from().select().eq()...maybeSingle(), .insert()...single(). Mirrors
 * selfbill.server.test.ts's fakeDb, kept local to this file per this
 * module's existing convention.
 */
function fakeDb(seed: {
  tables?: any[];
  tenants?: any[];
  orders?: any[];
  currencies?: any[];
  requests?: any[];
}) {
  const rows: Record<string, any[]> = {
    restaurant_tables: seed.tables ?? [],
    restaurant_tenants: seed.tenants ?? [],
    restaurant_orders: seed.orders ?? [],
    restaurant_currencies: seed.currencies ?? [],
    restaurant_service_requests: seed.requests ?? [],
  };

  function from(table: string) {
    let filtered = rows[table] ?? [];
    const builder: any = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle: async () => ({ data: filtered[0] ?? null }),
      single: async () => ({
        data: filtered[0] ?? null,
        error: filtered[0] ? null : { message: "not found" },
      }),
      insert(row: Record<string, unknown>) {
        const inserted = { ...row };
        rows[table]!.push(inserted);
        return {
          select() {
            return {
              single: async () => ({ data: inserted, error: null }),
            };
          },
        };
      },
      then: (resolve: (v: { data: any[] }) => unknown) => resolve({ data: filtered }),
    };
    return builder;
  }

  return { from };
}

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";
const TABLE = "table-1";
const OTHER_TABLE = "table-2";
const ORDER = "order-1";

function seedFor(opts: {
  orderOverrides?: Partial<Record<string, unknown>>;
  requests?: any[];
  tenantSettings?: Record<string, unknown>;
}) {
  return fakeDb({
    tables: [
      {
        id: TABLE,
        code: "T1",
        name: "T1",
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        active: true,
      },
      {
        id: OTHER_TABLE,
        code: "T2",
        name: "T2",
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        active: true,
      },
    ],
    tenants: [
      { id: TENANT, name: "Demo", status: "active", settings: opts.tenantSettings ?? {} },
      { id: OTHER_TENANT, name: "Other tenant", status: "active", settings: {} },
    ],
    orders: [
      {
        id: ORDER,
        order_number: "ORD-1",
        status: "open",
        table_id: TABLE,
        tenant_id: TENANT,
        ...opts.orderOverrides,
      },
    ],
    requests: (opts.requests ?? []).map((r) => ({
      tenant_id: TENANT,
      order_id: ORDER,
      request_type: "assistance",
      resolved_at: null,
      ...r,
    })),
  });
}

describe("requestStaff", () => {
  it("a valid guest/table/order can request staff", async () => {
    const sb = seedFor({});
    const result = await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({
      ok: true,
      status: "requested",
      requestedAt: expect.any(String),
    });
  });

  it("the wrong table cannot request staff for this order", async () => {
    const sb = seedFor({});
    await expect(requestStaff(sb, { tableId: OTHER_TABLE, orderId: ORDER })).rejects.toThrow(
      /not found/i,
    );
  });

  it("a table belonging to a different tenant cannot request staff for this order", async () => {
    const sb = fakeDb({
      tables: [
        {
          id: "table-cross-tenant",
          code: "TX",
          name: "TX",
          tenant_id: OTHER_TENANT,
          property_id: null,
          location_id: null,
          active: true,
        },
      ],
      tenants: [
        { id: TENANT, name: "Demo", status: "active", settings: {} },
        { id: OTHER_TENANT, name: "Other tenant", status: "active", settings: {} },
      ],
      orders: [
        {
          id: ORDER,
          order_number: "ORD-1",
          status: "open",
          table_id: "table-cross-tenant",
          tenant_id: TENANT,
        },
      ],
    });
    await expect(
      requestStaff(sb, { tableId: "table-cross-tenant", orderId: ORDER }),
    ).rejects.toThrow(/not found/i);
  });

  it("a nonexistent order is safely rejected, not silently accepted", async () => {
    const sb = seedFor({});
    await expect(requestStaff(sb, { tableId: TABLE, orderId: "no-such-order" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("a cancelled order cannot request staff", async () => {
    const sb = seedFor({ orderOverrides: { status: "cancelled" } });
    const result = await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ ok: false, reason: "not_requestable", orderStatus: "cancelled" });
  });

  it("a closed order with no prior request cannot request staff", async () => {
    const sb = seedFor({ orderOverrides: { status: "closed" } });
    const result = await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ ok: false, reason: "not_requestable", orderStatus: "closed" });
  });

  it("a duplicate tap is idempotent — the second call returns the same request, not a new one", async () => {
    const sb = seedFor({});
    const first = await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    const second = await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    expect(first).toEqual(second);
  });

  it("repeated taps never create more than one active row", async () => {
    const sb = seedFor({});
    await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    const { data } = await (sb.from("restaurant_service_requests") as any)
      .select()
      .eq("order_id", ORDER);
    expect(data.filter((r: any) => r.status === "requested")).toHaveLength(1);
  });

  it("an already-acknowledged request is preserved, not re-requested by a poll", async () => {
    const ACK = "2026-01-01T10:05:00.000Z";
    const REQ = "2026-01-01T10:00:00.000Z";
    const sb = seedFor({
      requests: [{ status: "acknowledged", requested_at: REQ, acknowledged_at: ACK }],
    });
    const status = await guestStaffRequestStatus(sb, { tableId: TABLE, orderId: ORDER });
    expect(status).toEqual({
      ok: true,
      status: "acknowledged",
      requestedAt: REQ,
      acknowledgedAt: ACK,
    });
  });

  it("§B — an acknowledged request blocks a new one: tapping again while staff is already on it must NOT create a second request", async () => {
    const sb = seedFor({
      requests: [
        {
          status: "acknowledged",
          requested_at: "2026-01-01T10:00:00.000Z",
          acknowledged_at: "2026-01-01T10:05:00.000Z",
        },
      ],
    });
    const result = await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({
      ok: true,
      status: "acknowledged",
      requestedAt: "2026-01-01T10:00:00.000Z",
      acknowledgedAt: "2026-01-01T10:05:00.000Z",
    });
    const { data } = await (sb.from("restaurant_service_requests") as any)
      .select()
      .eq("order_id", ORDER);
    expect(data).toHaveLength(1); // no second row was inserted
  });

  it("no request yet reads as status 'available', not an error", async () => {
    const sb = seedFor({});
    const status = await guestStaffRequestStatus(sb, { tableId: TABLE, orderId: ORDER });
    expect(status).toEqual({ ok: true, status: "available" });
  });

  it("§C — a resolved request within the cooldown window blocks a new request and reports remaining time", async () => {
    const resolvedAt = new Date(Date.now() - 60_000).toISOString(); // resolved 60s ago
    const sb = seedFor({
      requests: [
        {
          status: "resolved",
          requested_at: new Date(Date.now() - 120_000).toISOString(),
          acknowledged_at: new Date(Date.now() - 90_000).toISOString(),
          resolved_at: resolvedAt,
        },
      ],
      // Default cooldown (300s) applies since no tenant setting is configured.
    });
    const status = await guestStaffRequestStatus(sb, { tableId: TABLE, orderId: ORDER });
    expect(status.ok).toBe(true);
    expect((status as any).status).toBe("cooldown");
    expect((status as any).resolvedAt).toBe(resolvedAt);
    // ~300s window minus the 60s already elapsed, allowing a little slack for test timing.
    expect((status as any).cooldownRemainingSeconds).toBeGreaterThan(235);
    expect((status as any).cooldownRemainingSeconds).toBeLessThanOrEqual(240);

    const requestResult = await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    expect(requestResult.ok).toBe(true);
    expect((requestResult as any).status).toBe("cooldown");
    const { data } = await (sb.from("restaurant_service_requests") as any)
      .select()
      .eq("order_id", ORDER);
    expect(data).toHaveLength(1); // still no new row — cooldown blocked the insert
  });

  it("§C — a resolved request past the cooldown window is available again, and a new request can be created", async () => {
    const resolvedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // resolved 10 minutes ago
    const sb = seedFor({
      requests: [
        {
          status: "resolved",
          requested_at: new Date(Date.now() - 12 * 60_000).toISOString(),
          acknowledged_at: new Date(Date.now() - 11 * 60_000).toISOString(),
          resolved_at: resolvedAt,
        },
      ],
      // Default cooldown is 5 minutes — 10 minutes have elapsed.
    });
    const status = await guestStaffRequestStatus(sb, { tableId: TABLE, orderId: ORDER });
    expect(status).toEqual({ ok: true, status: "available" });

    const result = await requestStaff(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ ok: true, status: "requested", requestedAt: expect.any(String) });
    const { data } = await (sb.from("restaurant_service_requests") as any)
      .select()
      .eq("order_id", ORDER);
    expect(data.filter((r: any) => r.status === "requested")).toHaveLength(1);
  });

  it("the configured tenant cooldown (settings.serviceRequests.cooldownSeconds) overrides the default", async () => {
    const resolvedAt = new Date(Date.now() - 30_000).toISOString(); // resolved 30s ago
    const sb = seedFor({
      requests: [
        {
          status: "resolved",
          requested_at: new Date(Date.now() - 90_000).toISOString(),
          acknowledged_at: new Date(Date.now() - 60_000).toISOString(),
          resolved_at: resolvedAt,
        },
      ],
      tenantSettings: { serviceRequests: { cooldownSeconds: 10 } }, // much shorter than the 300s default
    });
    // 30s have already elapsed against a 10s configured cooldown — available again.
    const status = await guestStaffRequestStatus(sb, { tableId: TABLE, orderId: ORDER });
    expect(status).toEqual({ ok: true, status: "available" });
  });

  it("a concurrent insert conflict (the database's own uniqueness guard) falls back to the row that won the race, instead of failing the guest's tap", async () => {
    const REQ = "2026-01-01T10:00:00.000Z";
    let selectCalls = 0;
    const sb = {
      from(table: string) {
        if (table === "restaurant_service_requests") {
          const builder: any = {
            select() {
              return builder;
            },
            eq() {
              return builder;
            },
            order() {
              return builder;
            },
            limit() {
              return builder;
            },
            maybeSingle: async () => {
              selectCalls += 1;
              // First read (the app-level pre-check) sees nothing yet — a
              // concurrent request is about to win the race. Every read
              // after that sees what the race actually produced.
              return {
                data:
                  selectCalls === 1
                    ? null
                    : {
                        status: "requested",
                        requested_at: REQ,
                        acknowledged_at: null,
                        resolved_at: null,
                      },
              };
            },
            insert() {
              return {
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: "23505", message: "conflict" },
                  }),
                }),
              };
            },
          };
          return builder;
        }
        // Delegate table/tenant/order/currency lookups to a normal seeded fakeDb.
        return seedFor({}).from(table);
      },
    };
    const result = await requestStaff(sb as any, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({
      ok: true,
      status: "requested",
      requestedAt: REQ,
    });
  });
});
