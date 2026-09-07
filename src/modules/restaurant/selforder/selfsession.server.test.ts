/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Guest dining-session projection — proves the defect described in the
 * remediation brief is actually fixed: placing Order B must never make
 * Order A disappear from the guest's tracked view, and the guest must be
 * able to see cumulative session/table expenditure across every order the
 * session has produced so far.
 *
 * Exercises the real submitGuestOrder -> resolveOrStartGuestSession ->
 * createGuestOrder -> guestSessionProjection chain against a genuine
 * in-memory Supabase fake, the same style as
 * selforder.submit.server.test.ts and selforder.bar-routing.property-scope.
 * test.ts — no step of that chain is mocked out.
 */
import { describe, expect, it } from "vitest";
import { submitGuestOrder, closeActiveGuestSession } from "./selforder.server";
import { guestSessionProjection } from "./selfsession.server";
import type { GuestLineInput } from "./selforder.contracts";

const TENANT = "tenant-1";
const TABLE = "table-1";
const OTHER_TABLE = "table-2";
const MENU = "menu-1";
const CATEGORY = "cat-mains";
const CATEGORY_DRINKS = "cat-drinks";
const ITEM_COLA = "item-cola";
const ITEM_FRIES = "item-fries";
const PRODUCT_COLA = "product-cola";
const PRODUCT_FRIES = "product-fries";

/** Same genuine in-memory table store as selforder.submit.server.test.ts. */
function makeFakeSupabase(initial: Record<string, any[]>) {
  const store: Record<string, any[]> = {};
  for (const [table, rows] of Object.entries(initial)) store[table] = rows.map((r) => ({ ...r }));
  let seq = 0;
  const nextId = (table: string) => `${table}-${++seq}`;

  function from(table: string) {
    if (!store[table]) store[table] = [];
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: any;
    let limitN: number | null = null;

    function execute(mode: "single" | "maybeSingle" | "many") {
      const rows = store[table];
      if (op === "select") {
        let matched = rows.filter((r) => filters.every((f) => f(r)));
        if (limitN != null) matched = matched.slice(0, limitN);
        if (mode === "single") {
          return matched.length >= 1
            ? { data: matched[0], error: null }
            : { data: null, error: { message: `${table}: not found` } };
        }
        if (mode === "maybeSingle") return { data: matched[0] ?? null, error: null };
        return { data: matched, error: null };
      }
      if (op === "insert") {
        const incoming = Array.isArray(payload) ? payload : [payload];
        if (table === "restaurant_orders") {
          for (const row of incoming) {
            if (row.client_request_id != null) {
              const conflict = rows.find(
                (r) =>
                  r.tenant_id === row.tenant_id && r.client_request_id === row.client_request_id,
              );
              if (conflict) {
                return {
                  data: null,
                  error: {
                    code: "23505",
                    message:
                      'duplicate key value violates unique constraint "restaurant_orders_client_request_idx"',
                  },
                };
              }
            }
          }
        }
        if (table === "restaurant_guest_sessions") {
          for (const row of incoming) {
            if (
              row.status === "active" &&
              rows.some((r) => r.table_id === row.table_id && r.status === "active")
            ) {
              return {
                data: null,
                error: { message: "duplicate key value violates unique constraint" },
              };
            }
          }
        }
        const inserted = incoming.map((row: any) => {
          const full = { id: row.id ?? nextId(table), ...row };
          rows.push(full);
          return full;
        });
        if (mode === "single") return { data: inserted[0], error: null };
        if (mode === "maybeSingle") return { data: inserted[0] ?? null, error: null };
        return { data: inserted, error: null };
      }
      if (op === "update") {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        for (const r of matched) Object.assign(r, payload);
        if (mode === "single") {
          return matched.length >= 1
            ? { data: matched[0], error: null }
            : { data: null, error: { message: `${table}: not found` } };
        }
        if (mode === "maybeSingle") return { data: matched[0] ?? null, error: null };
        return { data: matched, error: null };
      }
      return { data: null, error: null };
    }

    const api: any = {
      select: () => api,
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filters.push((r) => set.has(r[col]));
        return api;
      },
      lt(col: string, val: string) {
        filters.push((r) => r[col] != null && r[col] < val);
        return api;
      },
      not(col: string, _kind: string, val: unknown) {
        if (val === null) filters.push((r) => r[col] != null);
        return api;
      },
      order: () => api,
      limit(n: number) {
        limitN = n;
        return api;
      },
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      update(patch: any) {
        op = "update";
        payload = patch;
        return api;
      },
      maybeSingle: () => Promise.resolve(execute("maybeSingle")),
      single: () => Promise.resolve(execute("single")),
      then(onFulfilled: any, onRejected: any) {
        return Promise.resolve(execute("many")).then(onFulfilled, onRejected);
      },
    };
    return api;
  }

  return { from, store } as any;
}

function baseRows(overrides: Partial<Record<string, any[]>> = {}) {
  return {
    restaurant_tables: [
      {
        id: TABLE,
        code: "T1",
        name: "T1",
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        active: true,
        status: "available",
      },
      {
        id: OTHER_TABLE,
        code: "T2",
        name: "T2",
        tenant_id: TENANT,
        property_id: null,
        location_id: null,
        active: true,
        status: "available",
      },
    ],
    restaurant_tenants: [{ id: TENANT, name: "Demo", status: "active", settings: null }],
    restaurant_currencies: [],
    restaurant_menus: [
      {
        id: MENU,
        name: "Main menu",
        status: "published",
        currency: "USD",
        location_id: null,
        tenant_id: TENANT,
      },
    ],
    restaurant_categories: [
      {
        id: CATEGORY,
        name: "Mains",
        slug: "mains",
        kind: "menu",
        sort_order: 1,
        tenant_id: TENANT,
      },
      {
        id: CATEGORY_DRINKS,
        name: "Drinks",
        slug: "drinks",
        kind: "menu",
        sort_order: 2,
        tenant_id: TENANT,
      },
    ],
    restaurant_menu_items: [
      {
        id: ITEM_COLA,
        menu_id: MENU,
        category_id: CATEGORY_DRINKS,
        name: "Cola",
        description: "Ice cold cola",
        price: 2000,
        currency: "USD",
        available: true,
        tags: [],
        allergens: [],
        sort_order: 1,
        image_url: null,
        tenant_id: TENANT,
      },
      {
        id: ITEM_FRIES,
        menu_id: MENU,
        category_id: CATEGORY,
        name: "Fries",
        description: "Salted fries",
        price: 3000,
        currency: "USD",
        available: true,
        tags: [],
        allergens: [],
        sort_order: 2,
        image_url: null,
        tenant_id: TENANT,
      },
    ],
    restaurant_products: [
      {
        id: PRODUCT_COLA,
        name: "Cola",
        menu_item_id: ITEM_COLA,
        station_id: null,
        price: null,
        product_type: "menu_item",
        active: true,
        tenant_id: TENANT,
      },
      {
        id: PRODUCT_FRIES,
        name: "Fries",
        menu_item_id: ITEM_FRIES,
        station_id: null,
        price: null,
        product_type: "menu_item",
        active: true,
        tenant_id: TENANT,
      },
    ],
    restaurant_product_variants: [],
    restaurant_modifier_groups: [],
    restaurant_modifiers: [],
    restaurant_product_modifier_groups: [],
    restaurant_stations: [],
    restaurant_prices: [
      {
        id: "price-cola",
        scope: "tenant",
        amount: 2000,
        currency: "USD",
        tax_inclusive: false,
        version: 1,
        status: "active",
        effective_from: "2020-01-01T00:00:00.000Z",
        effective_to: null,
        property_id: null,
        location_id: null,
        product_id: null,
        variant_id: null,
        menu_item_id: ITEM_COLA,
        price_list_id: null,
        channel: null,
        tenant_id: TENANT,
      },
      {
        id: "price-fries",
        scope: "tenant",
        amount: 3000,
        currency: "USD",
        tax_inclusive: false,
        version: 1,
        status: "active",
        effective_from: "2020-01-01T00:00:00.000Z",
        effective_to: null,
        property_id: null,
        location_id: null,
        product_id: null,
        variant_id: null,
        menu_item_id: ITEM_FRIES,
        price_list_id: null,
        channel: null,
        tenant_id: TENANT,
      },
    ],
    restaurant_promotions: [],
    restaurant_tax_rules: [],
    restaurant_service_charges: [],
    restaurant_price_lists: [],
    restaurant_rounding_rules: [],
    restaurant_recipe_costs: [],
    restaurant_recipes: [],
    restaurant_guest_sessions: [],
    restaurant_orders: [],
    restaurant_order_items: [],
    restaurant_payments: [],
    restaurant_kitchen_tickets: [],
    restaurant_kitchen_ticket_items: [],
    ...overrides,
  };
}

function colaLine(overrides: Partial<GuestLineInput> = {}): GuestLineInput {
  return {
    menuItemId: ITEM_COLA,
    description: "Cola",
    quantity: 1,
    unitPrice: 0,
    discount: 0,
    modifiers: [],
    ...overrides,
  };
}

function friesLine(overrides: Partial<GuestLineInput> = {}): GuestLineInput {
  return {
    menuItemId: ITEM_FRIES,
    description: "Fries",
    quantity: 1,
    unitPrice: 0,
    discount: 0,
    modifiers: [],
    ...overrides,
  };
}

describe("guest dining session — the continuous-session defect (tests 13-30)", () => {
  it("13: the first order creates a session and Order A", async () => {
    const sb = makeFakeSupabase(baseRows());
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-a",
    });
    expect(a.session.session).not.toBeNull();
    expect(a.session.orders).toHaveLength(1);
    expect(a.session.orders[0]!.id).toBe(a.id);
    expect(sb.store.restaurant_guest_sessions).toHaveLength(1);
    expect(sb.store.restaurant_orders[0].guest_session_id).toBe(
      sb.store.restaurant_guest_sessions[0].id,
    );
  });

  it("14/17: a second and third order with the same session token reuse the SAME session and create new orders A, B, C", async () => {
    const sb = makeFakeSupabase(baseRows());
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-a",
    });
    const b = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [friesLine()],
      sessionToken: a.guestSessionToken,
      clientRequestId: "req-b",
    });
    const c = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine(), friesLine()],
      sessionToken: b.guestSessionToken,
      clientRequestId: "req-c",
    });

    expect(a.id).not.toBe(b.id);
    expect(b.id).not.toBe(c.id);
    expect(sb.store.restaurant_guest_sessions).toHaveLength(1); // one session, not three
    expect(sb.store.restaurant_orders).toHaveLength(3); // three independent orders

    // 15/16: Order A is still visible after B and C — never overwritten.
    const projection = await guestSessionProjection(sb, { tableId: TABLE });
    const orderIds = projection.orders.map((o) => o.id);
    expect(orderIds).toEqual([a.id, b.id, c.id]);
  });

  it("18/19/20: session totals/paid/outstanding are the server-derived sum across every order, not a client accumulator", async () => {
    const sb = makeFakeSupabase(baseRows());
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()], // 2000
      clientRequestId: "req-a",
    });
    const b = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [friesLine()], // 3000
      sessionToken: a.guestSessionToken,
      clientRequestId: "req-b",
    });

    const projection = await guestSessionProjection(sb, { tableId: TABLE });
    expect(projection.totals.total).toBe(5000);
    expect(projection.totals.paid).toBe(0);
    expect(projection.totals.outstanding).toBe(5000);

    // Record a payment against Order A only — session totals must reflect
    // it without any client-side arithmetic, and Order B stays unpaid.
    sb.store.restaurant_orders.find((o: any) => o.id === a.id).paid_total = 2000;
    const afterPayment = await guestSessionProjection(sb, { tableId: TABLE });
    expect(afterPayment.totals.paid).toBe(2000);
    expect(afterPayment.totals.outstanding).toBe(3000);
    expect(afterPayment.orders.find((o) => o.id === a.id)!.outstanding).toBe(0);
    expect(afterPayment.orders.find((o) => o.id === b.id)!.outstanding).toBe(3000);
  });

  it("21: a cancelled order is shown with a cancelled stage and contributes nothing further owed, without hiding the rest of the session", async () => {
    const sb = makeFakeSupabase(baseRows());
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-a",
    });
    await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [friesLine()],
      sessionToken: a.guestSessionToken,
      clientRequestId: "req-b",
    });
    // Simulate the governed cancellation outcome directly (order/items voided, total zeroed) —
    // cancelOrder() itself is covered by cancellation.server.test.ts.
    const orderA = sb.store.restaurant_orders.find((o: any) => o.id === a.id);
    orderA.status = "cancelled";
    orderA.total = 0;
    orderA.subtotal = 0;

    const projection = await guestSessionProjection(sb, { tableId: TABLE });
    expect(projection.orders).toHaveLength(2);
    const cancelled = projection.orders.find((o) => o.id === a.id)!;
    expect(cancelled.overallStage).toBe("cancelled");
    expect(cancelled.total).toBe(0);
    // The other order is unaffected.
    const other = projection.orders.find((o) => o.id !== a.id)!;
    expect(other.overallStage).not.toBe("cancelled");
  });

  it("22: a refresh (a fresh projection call with no order id at all) recovers every active order, not just the last one", async () => {
    const sb = makeFakeSupabase(baseRows());
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-a",
    });
    await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [friesLine()],
      sessionToken: a.guestSessionToken,
      clientRequestId: "req-b",
    });

    // No token, no stored order id presented at all — table id alone.
    const recovered = await guestSessionProjection(sb, { tableId: TABLE });
    expect(recovered.orders).toHaveLength(2);
  });

  it("23: a session projection is strictly table-scoped — a different table sees no session and none of this table's orders", async () => {
    const sb = makeFakeSupabase(baseRows());
    await submitGuestOrder(sb, { tableId: TABLE, lines: [colaLine()], clientRequestId: "req-a" });

    const otherTable = await guestSessionProjection(sb, { tableId: OTHER_TABLE });
    expect(otherTable.session).toBeNull();
    expect(otherTable.orders).toHaveLength(0);
  });

  it("24: an order that was never linked to this table's session (a forged guest_session_id could never be set by a client in the first place) never appears in the projection", async () => {
    const sb = makeFakeSupabase(baseRows());
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-a",
    });

    // An order belonging to a completely unrelated session/table — the
    // guest_session_id is set exclusively by createGuestOrder, server-side,
    // from the session resolveOrStartGuestSession just validated; there is
    // no submitGuestOrder input a guest could ever pass to attach an
    // arbitrary order id to their own session.
    sb.store.restaurant_orders.push({
      id: "planted-order",
      tenant_id: TENANT,
      table_id: OTHER_TABLE,
      guest_session_id: "some-other-session",
      order_number: "ORD-PLANTED",
      status: "open",
      subtotal: 99999,
      discount_total: 0,
      tax_total: 0,
      service_charge: 0,
      total: 99999,
      paid_total: 0,
      currency: "USD",
      opened_at: new Date().toISOString(),
    });

    const projection = await guestSessionProjection(sb, { tableId: TABLE });
    expect(projection.orders.map((o) => o.id)).toEqual([a.id]);
    expect(projection.totals.total).toBe(2000); // unaffected by the planted row
  });

  it("25: once the table's session is closed (canonical release), a new order starts a NEW session and the old orders are no longer projected", async () => {
    const sb = makeFakeSupabase(baseRows());
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-a",
    });

    await closeActiveGuestSession(sb, TABLE, "table_released");

    const afterRelease = await guestSessionProjection(sb, { tableId: TABLE });
    expect(afterRelease.session).toBeNull();
    expect(afterRelease.orders).toHaveLength(0);

    // A brand-new guest scans the same table and orders — a fresh session,
    // never inheriting Order A.
    const b = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [friesLine()],
      clientRequestId: "req-b",
    });
    expect(b.session.orders.map((o: any) => o.id)).toEqual([b.id]);
    expect(sb.store.restaurant_guest_sessions).toHaveLength(2);
    // A genuinely new session row was created, not the closed one reused.
    const [firstSession, secondSession] = sb.store.restaurant_guest_sessions;
    expect(firstSession.id).not.toBe(secondSession.id);
    expect(firstSession.status).toBe("closed");
    expect(secondSession.status).toBe("active");
  });

  it("26/27/28: mixed Order A exposes independent kitchen+bar progress; Order B's progress never blends into Order A's, and one order finishing never marks the whole session ready", async () => {
    const sb = makeFakeSupabase(
      baseRows({
        restaurant_stations: [
          {
            id: "station-kitchen",
            tenant_id: TENANT,
            property_id: null,
            location_id: null,
            code: "KIT",
            name: "Kitchen",
            station_type: "kitchen",
            sort_order: 1,
            active: true,
          },
          {
            id: "station-bar",
            tenant_id: TENANT,
            property_id: null,
            location_id: null,
            code: "BAR",
            name: "Bar",
            station_type: "bar",
            sort_order: 2,
            active: true,
          },
        ],
      }),
    );
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine(), friesLine()],
      clientRequestId: "req-a",
    });
    const b = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [friesLine()],
      sessionToken: a.guestSessionToken,
      clientRequestId: "req-b",
    });

    // Advance only Order A's kitchen ticket to "ready" — Order B (its own,
    // separate ticket) must stay untouched.
    const ticketA = sb.store.restaurant_kitchen_tickets.find(
      (t: any) => t.order_id === a.id && t.station_id === "station-kitchen",
    );
    ticketA.status = "ready";

    const projection = await guestSessionProjection(sb, { tableId: TABLE });
    const orderA = projection.orders.find((o) => o.id === a.id)!;
    const orderB = projection.orders.find((o) => o.id === b.id)!;

    // Order A is a genuinely mixed order: independent kitchen + bar streams.
    expect(orderA.streams.map((s) => s.station).sort()).toEqual(["bar", "kitchen"]);
    expect(orderA.streams.find((s) => s.station === "kitchen")!.stage).toBe("ready");
    expect(orderA.streams.find((s) => s.station === "bar")!.stage).toBe("preparing");

    // Order B is unaffected by Order A's progress — genuinely independent.
    expect(orderB.streams).toEqual([{ station: "kitchen", stage: "preparing" }]);

    // No session-wide "ready" collapse: overallStage is computed per order
    // from that order's own tickets — Order A having a ready kitchen stream
    // does not promote Order B, and the projection itself carries no
    // aggregate "session stage" field for one order's progress to leak into.
    expect(orderB.overallStage).toBe("preparing");
    expect(projection).not.toHaveProperty("overallStage");
    expect(projection).not.toHaveProperty("stage");
  });

  it("29: the session stays active (and visible) while ordering is still permitted", async () => {
    const sb = makeFakeSupabase(baseRows());
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-a",
    });
    const projection = await guestSessionProjection(sb, { tableId: TABLE });
    expect(projection.session?.status).toBe("active");
    // A second order under the same token is still accepted — the session
    // never appears "closed" purely because an order was already placed.
    await expect(
      submitGuestOrder(sb, {
        tableId: TABLE,
        lines: [friesLine()],
        sessionToken: a.guestSessionToken,
        clientRequestId: "req-b",
      }),
    ).resolves.toBeTruthy();
  });

  it("30: order-level payment status (guestOrderStatus) still resolves correctly for an order that belongs to a session", async () => {
    const sb = makeFakeSupabase(baseRows());
    const a = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-a",
    });
    const { guestOrderStatus } = await import("./selfpay.server");
    const status = await guestOrderStatus(sb, { tableId: TABLE, orderId: a.id });
    expect(status.orderNumber).toBe(a.order_number);
    expect(status.total).toBe(2000);
  });
});
