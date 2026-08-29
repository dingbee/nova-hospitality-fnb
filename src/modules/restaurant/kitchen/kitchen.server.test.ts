/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * Ops UAT gap #10 (P0) — self-order tracking got permanently stuck at
 * "received".
 *
 * Root cause: submitGuestOrder created the order and its lines but never
 * fired them — kitchen tickets are only created by fireOrder, which
 * requires a staff `kitchen.manage` capability a guest scanning a table
 * doesn't have. The confirmation screen tells the guest their order is "on
 * its way to the kitchen and bar", but nothing made that true until a staff
 * member happened to notice the still-"open" order and fire it by hand —
 * so the guest's own tracker (selftrack.server.ts's guestOrderProgress)
 * never advanced past "received", indefinitely.
 *
 * Fixed by extracting fireOrder's ticket-creation core (fireOrderItemsCore)
 * from its capability check, and exposing fireGuestOrder — the same
 * ticket-creation logic, safe to call with no staff principal — which
 * submitGuestOrder now calls right after creating the order.
 */
import { describe, expect, it } from "vitest";
import { fireGuestOrder, fireOrder, listTickets } from "./kitchen.server";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const ORDER = "33333333-3333-3333-3333-333333333333";
const KITCHEN_STATION = "44444444-4444-4444-4444-444444444444";
const BAR_STATION = "55555555-5555-5555-5555-555555555555";

function makeFakeSupabase(opts: {
  orderStatus?: string;
  items: Array<{ id: string; station_id: string | null; status: string; quantity?: number }>;
  restaurantMembers?: Array<{ tenant_id: string; user_id: string; role: string }>;
}) {
  const order = {
    id: ORDER,
    order_number: "ORD-1",
    status: opts.orderStatus ?? "open",
    location_id: null,
    property_id: null,
  };
  const items = opts.items.map((i) => ({
    tenant_id: TENANT,
    order_id: ORDER,
    menu_item_id: null,
    description: "Item",
    quantity: i.quantity ?? 1,
    course: null,
    notes: null,
    ...i,
  }));
  const tickets: any[] = [];
  const ticketItems: any[] = [];
  let seq = 0;

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let op: "select" | "update" | "insert" = "select";
    let payload: any;

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        inFilters[col] = vals;
        return api;
      },
      update: (patch: any) => {
        op = "update";
        payload = patch;
        return api;
      },
      insert: (row: any) => {
        op = "insert";
        payload = row;
        return api;
      },
      single: () => resolve(),
      maybeSingle: () => resolve(),
      then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
    };

    async function resolve() {
      if (table === "restaurant_orders") {
        if (op === "select") return { data: filters.id === ORDER ? order : null, error: null };
        if (op === "update") {
          if (filters.status && order.status !== filters.status) return { data: null, error: null };
          order.status = payload.status;
          return { data: order, error: null };
        }
      }
      if (table === "restaurant_order_items") {
        if (op === "select") {
          let rows = items;
          if (inFilters.id) rows = rows.filter((i) => inFilters.id!.includes(i.id));
          return { data: rows, error: null };
        }
        if (op === "update") {
          for (const id of (inFilters.id ?? []) as string[]) {
            const item = items.find((i) => i.id === id);
            if (item) item.status = payload.status;
          }
          return { data: null, error: null };
        }
      }
      if (table === "restaurant_stations" && op === "select") {
        return {
          data: [
            { id: KITCHEN_STATION, target_prep_minutes: 15 },
            { id: BAR_STATION, target_prep_minutes: 5 },
          ],
          error: null,
        };
      }
      if (table === "restaurant_kitchen_tickets" && op === "insert") {
        seq += 1;
        const ticket = { id: `ticket-${seq}`, ...payload };
        tickets.push(ticket);
        return { data: ticket, error: null };
      }
      if (table === "restaurant_kitchen_ticket_items" && op === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        ticketItems.push(...rows);
        return { data: null, error: null };
      }
      if (table === "restaurant_members") {
        const rows = (opts.restaurantMembers ?? []).filter(
          (m) => m.tenant_id === filters.tenant_id && m.user_id === filters.user_id,
        );
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    }

    return api;
  }

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (fn: string) =>
        fn === "has_any_role" ? { data: false, error: null } : { data: null, error: null },
    },
    order,
    items,
    tickets,
    ticketItems,
  };
}

describe("fireGuestOrder — guest-safe entry point, no staff principal required", () => {
  it("creates one ticket per station and fires every ordered item", async () => {
    const fake = makeFakeSupabase({
      items: [
        { id: "item-1", station_id: KITCHEN_STATION, status: "ordered" },
        { id: "item-2", station_id: BAR_STATION, status: "ordered" },
      ],
    });

    const result = await fireGuestOrder(fake.supabase, { tenantId: TENANT, orderId: ORDER });

    expect(result).toEqual({ fired: 2 });
    expect(fake.tickets).toHaveLength(2);
    expect(fake.ticketItems).toHaveLength(2);
    expect(fake.items.every((i) => i.status === "fired")).toBe(true);
    expect(fake.order.status).toBe("sent");
  });

  it("is idempotent — firing twice never creates a second round of tickets", async () => {
    const fake = makeFakeSupabase({
      items: [{ id: "item-1", station_id: KITCHEN_STATION, status: "ordered" }],
    });

    await fireGuestOrder(fake.supabase, { tenantId: TENANT, orderId: ORDER });
    expect(fake.tickets).toHaveLength(1);

    const second = await fireGuestOrder(fake.supabase, { tenantId: TENANT, orderId: ORDER });
    expect(second).toEqual({ fired: 0 });
    expect(fake.tickets).toHaveLength(1); // unchanged
  });

  it("never throws — a firing failure is reported, not raised into the caller", async () => {
    const fake = makeFakeSupabase({ items: [] });
    // No such order exists.
    const result = await fireGuestOrder(fake.supabase, {
      tenantId: TENANT,
      orderId: "no-such-order",
    });
    expect(result.fired).toBe(0);
    expect((result as any).error).toMatch(/order not found/i);
  });

  it("refuses to fire a closed order, reported as a failure rather than corrupting state", async () => {
    const fake = makeFakeSupabase({
      orderStatus: "closed",
      items: [{ id: "item-1", station_id: KITCHEN_STATION, status: "ordered" }],
    });
    const result = await fireGuestOrder(fake.supabase, { tenantId: TENANT, orderId: ORDER });
    expect(result.fired).toBe(0);
    expect((result as any).error).toMatch(/closed order/i);
    expect(fake.tickets).toHaveLength(0);
  });
});

describe("fireOrder — staff path is unaffected by the extraction", () => {
  it("still requires kitchen.manage and behaves exactly as before", async () => {
    const fake = makeFakeSupabase({
      items: [{ id: "item-1", station_id: KITCHEN_STATION, status: "ordered" }],
      restaurantMembers: [{ tenant_id: TENANT, user_id: USER, role: "chef" }],
    });

    const result = await fireOrder(fake.supabase, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      orderItemIds: [],
      priority: 0,
    });
    expect(result).toEqual({ tickets: fake.tickets, fired: 1 });
  });

  it("refuses a caller without kitchen.manage", async () => {
    const fake = makeFakeSupabase({
      items: [{ id: "item-1", station_id: KITCHEN_STATION, status: "ordered" }],
      restaurantMembers: [{ tenant_id: TENANT, user_id: USER, role: "waiter" }],
    });

    await expect(
      fireOrder(fake.supabase, USER, {
        tenantId: TENANT,
        orderId: ORDER,
        orderItemIds: [],
        priority: 0,
      }),
    ).rejects.toThrow(/forbidden/i);
    expect(fake.tickets).toHaveLength(0);
  });
});

/**
 * P0 — the Kitchen board showed bar tickets alongside its own. Root cause:
 * listTickets carried no station filter at all unless a caller explicitly
 * supplied one, and the Kitchen route never did — every open ticket
 * tenant-wide (including the Bar board's own, already-correctly-routed
 * tickets) came back. The ticket itself was never duplicated or
 * mis-routed (see fireGuestOrder's "creates one ticket per station" above,
 * and stationRouting.test.ts) — this is purely the read side.
 */
function fakeListTicketsDb(rows: Record<string, any[]>) {
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
      order() {
        return builder;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return builder;
      },
      then: (resolve: (v: { data: any[]; error: null }) => unknown) =>
        resolve({ data: filtered, error: null }),
    };
    return builder;
  }
  return {
    from,
    rpc: async () => ({ data: false, error: null }),
  };
}

function ticketsBaseRows(overrides: Partial<Record<string, any[]>> = {}) {
  return {
    restaurant_members: [{ tenant_id: TENANT, user_id: USER, role: "manager" }],
    restaurant_kitchen_ticket_items: [],
    restaurant_orders: [],
    restaurant_tables: [],
    ...overrides,
  };
}

describe("listTickets — station-scoped reads (the Kitchen board's own fix)", () => {
  const kitchenTicket = {
    tenant_id: TENANT,
    id: "ticket-kitchen",
    ticket_number: "KOT-1-1",
    order_id: null,
    station_id: KITCHEN_STATION,
    status: "queued",
    priority: 0,
    course: null,
    target_minutes: 15,
    queued_at: new Date().toISOString(),
  };
  const barTicket = {
    ...kitchenTicket,
    id: "ticket-bar",
    ticket_number: "KOT-1-2",
    station_id: BAR_STATION,
  };

  it("1/2. a bar-only ticket is excluded when scoped to kitchen stations — Kitchen shows exactly its own, zero bar", async () => {
    const fake = fakeListTicketsDb(
      ticketsBaseRows({ restaurant_kitchen_tickets: [kitchenTicket, barTicket] }),
    );
    const rows = await listTickets(fake, USER, {
      tenantId: TENANT,
      stationIds: [KITCHEN_STATION],
      openOnly: false,
      limit: 100,
    } as any);
    expect(rows.map((r: any) => r.id)).toEqual(["ticket-kitchen"]);
  });

  it("3/4. a kitchen-only ticket is excluded when scoped to bar stations — Bar's own existing scoped read stays correct", async () => {
    const fake = fakeListTicketsDb(
      ticketsBaseRows({ restaurant_kitchen_tickets: [kitchenTicket, barTicket] }),
    );
    const rows = await listTickets(fake, USER, {
      tenantId: TENANT,
      stationIds: [BAR_STATION],
      openOnly: false,
      limit: 100,
    } as any);
    expect(rows.map((r: any) => r.id)).toEqual(["ticket-bar"]);
  });

  it("5. a mixed order's two tickets split correctly across the two scoped reads — no cross-station leakage either way", async () => {
    const fake = fakeListTicketsDb(
      ticketsBaseRows({ restaurant_kitchen_tickets: [kitchenTicket, barTicket] }),
    );
    const kitchenRows = await listTickets(fake, USER, {
      tenantId: TENANT,
      stationIds: [KITCHEN_STATION],
      openOnly: false,
      limit: 100,
    } as any);
    const barRows = await listTickets(fake, USER, {
      tenantId: TENANT,
      stationIds: [BAR_STATION],
      openOnly: false,
      limit: 100,
    } as any);
    expect(kitchenRows).toHaveLength(1);
    expect(barRows).toHaveLength(1);
    expect(kitchenRows[0].id).not.toBe(barRows[0].id);
  });

  it("an explicit empty station scope (a tenant with no kitchen-type stations yet) returns nothing, not everything", async () => {
    const fake = fakeListTicketsDb(
      ticketsBaseRows({ restaurant_kitchen_tickets: [kitchenTicket, barTicket] }),
    );
    const rows = await listTickets(fake, USER, {
      tenantId: TENANT,
      stationIds: [],
      openOnly: false,
      limit: 100,
    } as any);
    expect(rows).toEqual([]);
  });

  it("no station scope at all preserves the Overview dashboard's existing unfiltered, tenant-wide read", async () => {
    const fake = fakeListTicketsDb(
      ticketsBaseRows({ restaurant_kitchen_tickets: [kitchenTicket, barTicket] }),
    );
    const rows = await listTickets(fake, USER, {
      tenantId: TENANT,
      openOnly: false,
      limit: 100,
    } as any);
    expect(rows.map((r: any) => r.id).sort()).toEqual(["ticket-bar", "ticket-kitchen"]);
  });

  it("8. a same-station ticket belonging to another tenant never appears, regardless of station scope", async () => {
    const otherTenantTicket = { ...kitchenTicket, id: "ticket-foreign", tenant_id: "other-tenant" };
    const fake = fakeListTicketsDb(
      ticketsBaseRows({ restaurant_kitchen_tickets: [kitchenTicket, otherTenantTicket] }),
    );
    const rows = await listTickets(fake, USER, {
      tenantId: TENANT,
      stationIds: [KITCHEN_STATION],
      openOnly: false,
      limit: 100,
    } as any);
    expect(rows.map((r: any) => r.id)).toEqual(["ticket-kitchen"]);
  });
});
