/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it } from "vitest";
import { guestOrderProgress } from "./selftrack.server";

/**
 * In-memory Supabase stand-in covering the chains selftrack.server uses:
 * .from().select().eq()...maybeSingle()/single(), and the bare-awaited
 * .select().eq().eq()/.in() form (no terminal method) that
 * restaurant_order_items/restaurant_kitchen_tickets/restaurant_stations
 * reads use here. Mirrors selfbill.server.test.ts's fakeDb, kept local to
 * this file per this module's existing convention.
 */
function fakeDb(seed: {
  tables?: any[];
  tenants?: any[];
  orders?: any[];
  currencies?: any[];
  items?: any[];
  tickets?: any[];
  stations?: any[];
}) {
  const rows: Record<string, any[]> = {
    restaurant_tables: seed.tables ?? [],
    restaurant_tenants: seed.tenants ?? [],
    restaurant_orders: seed.orders ?? [],
    restaurant_currencies: seed.currencies ?? [],
    restaurant_order_items: seed.items ?? [],
    restaurant_kitchen_tickets: seed.tickets ?? [],
    restaurant_stations: seed.stations ?? [],
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
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filtered = filtered.filter((r) => set.has(r[col]));
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
const STATION_KITCHEN = "station-kitchen";
const STATION_BAR = "station-bar";

function seedFor(opts: {
  orderOverrides?: Partial<Record<string, unknown>>;
  items?: any[];
  tickets?: any[];
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
      { id: TENANT, name: "Demo", status: "active" },
      { id: OTHER_TENANT, name: "Other tenant", status: "active" },
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
    items: (opts.items ?? []).map((i) => ({ tenant_id: TENANT, order_id: ORDER, ...i })),
    tickets: (opts.tickets ?? []).map((t) => ({ tenant_id: TENANT, order_id: ORDER, ...t })),
    stations: [
      { id: STATION_KITCHEN, tenant_id: TENANT, station_type: "hot" },
      { id: STATION_BAR, tenant_id: TENANT, station_type: "bar" },
    ],
  });
}

describe("guestOrderProgress", () => {
  it("a valid guest/table/order can read progress for an order not yet fired", async () => {
    const sb = seedFor({
      items: [
        { status: "ordered", station_id: STATION_KITCHEN },
        { status: "ordered", station_id: STATION_BAR },
      ],
    });
    const result = await guestOrderProgress(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({
      orderNumber: "ORD-1",
      overallStage: "received",
      streams: [
        { station: "kitchen", stage: "received" },
        { station: "bar", stage: "received" },
      ],
    });
  });

  it("the wrong table cannot read progress for this order", async () => {
    const sb = seedFor({});
    await expect(guestOrderProgress(sb, { tableId: OTHER_TABLE, orderId: ORDER })).rejects.toThrow(
      /not found/i,
    );
  });

  it("a table belonging to a different tenant cannot read progress for this order", async () => {
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
        { id: TENANT, name: "Demo", status: "active" },
        { id: OTHER_TENANT, name: "Other tenant", status: "active" },
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
      guestOrderProgress(sb, { tableId: "table-cross-tenant", orderId: ORDER }),
    ).rejects.toThrow(/not found/i);
  });

  it("a nonexistent order is safely rejected, not silently accepted", async () => {
    const sb = seedFor({});
    await expect(
      guestOrderProgress(sb, { tableId: TABLE, orderId: "no-such-order" }),
    ).rejects.toThrow(/not found/i);
  });

  it("a cancelled order returns the cancelled state, not stale ticket data", async () => {
    const sb = seedFor({
      orderOverrides: { status: "cancelled" },
      tickets: [{ status: "ready", station_id: STATION_KITCHEN }],
    });
    const result = await guestOrderProgress(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ orderNumber: "ORD-1", overallStage: "cancelled", streams: [] });
  });

  it("a voided order returns the same cancelled-state handling", async () => {
    const sb = seedFor({ orderOverrides: { status: "voided" } });
    const result = await guestOrderProgress(sb, { tableId: TABLE, orderId: ORDER });
    expect(result).toEqual({ orderNumber: "ORD-1", overallStage: "cancelled", streams: [] });
  });

  it("kitchen preparing while bar is ready, end-to-end from raw ticket/station rows", async () => {
    const sb = seedFor({
      orderOverrides: { status: "sent" },
      items: [
        { status: "fired", station_id: STATION_KITCHEN },
        { status: "fired", station_id: STATION_BAR },
      ],
      tickets: [
        { status: "preparing", station_id: STATION_KITCHEN },
        { status: "ready", station_id: STATION_BAR },
      ],
    });
    const result = await guestOrderProgress(sb, { tableId: TABLE, orderId: ORDER });
    expect(result.overallStage).toBe("preparing");
    expect(result.streams).toEqual([
      { station: "kitchen", stage: "preparing" },
      { station: "bar", stage: "ready" },
    ]);
  });

  it("both stations served reads as an overall served order", async () => {
    const sb = seedFor({
      orderOverrides: { status: "served" },
      items: [
        { status: "fired", station_id: STATION_KITCHEN },
        { status: "fired", station_id: STATION_BAR },
      ],
      tickets: [
        { status: "served", station_id: STATION_KITCHEN },
        { status: "served", station_id: STATION_BAR },
      ],
    });
    const result = await guestOrderProgress(sb, { tableId: TABLE, orderId: ORDER });
    expect(result.overallStage).toBe("served");
    expect(result.streams).toEqual([
      { station: "kitchen", stage: "served" },
      { station: "bar", stage: "served" },
    ]);
  });

  it("internal ticket/item fields are never exposed — only orderNumber/overallStage/streams reach the guest", async () => {
    const sb = seedFor({
      tickets: [
        {
          status: "preparing",
          station_id: STATION_KITCHEN,
          id: "ticket-1",
          notes: "extra spicy — staff only",
          delay_seconds: 999,
        },
      ],
    });
    const result = await guestOrderProgress(sb, { tableId: TABLE, orderId: ORDER });
    expect(Object.keys(result).sort()).toEqual(["orderNumber", "overallStage", "streams"].sort());
    for (const stream of result.streams) {
      expect(Object.keys(stream).sort()).toEqual(["station", "stage"].sort());
    }
    expect(JSON.stringify(result)).not.toMatch(/ticket-1|extra spicy|999/);
  });

  it("a client-supplied station/status/tenant on the input is ignored — everything is re-derived server-side", async () => {
    const sb = seedFor({
      items: [{ status: "ordered", station_id: STATION_KITCHEN }],
    });
    const tampered = {
      tableId: TABLE,
      orderId: ORDER,
      tenantId: OTHER_TENANT,
      station: "bar",
      status: "served",
      overallStage: "served",
    } as any;
    const result = await guestOrderProgress(sb, tampered);
    expect(result).toEqual({
      orderNumber: "ORD-1",
      overallStage: "received",
      streams: [{ station: "kitchen", stage: "received" }],
    });
  });
});
