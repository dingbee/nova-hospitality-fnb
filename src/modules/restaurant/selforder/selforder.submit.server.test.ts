/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * GEP3 — double-submission protection, end to end.
 *
 * createGuestOrder() previously had zero idempotency: every invocation
 * unconditionally inserted a new restaurant_orders row with a fresh order
 * number. A guest double-tapping "Send order", a dropped-response retry, or
 * two tabs/devices submitting the same basket would each create a separate
 * real order, each fired to the kitchen/bar independently.
 *
 * These tests exercise the real submitGuestOrder() -> createGuestOrder() ->
 * insertLines() -> fireGuestOrder() chain against a genuine in-memory
 * Supabase fake (real inserts/updates, a real (tenant_id, client_request_id)
 * unique-constraint simulation on restaurant_orders matching the actual
 * partial unique index from migration 0001) rather than mocking any of that
 * chain out — "no duplicate order" only means something if the real write
 * path is exercised, not bypassed.
 */
import { describe, expect, it } from "vitest";
import { submitGuestOrder } from "./selforder.server";
import type { GuestLineInput } from "./selforder.contracts";

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";
const TABLE = "table-1";
const OTHER_TABLE = "table-2";
const MENU = "menu-1";
const CATEGORY = "cat-mains";
const ITEM_COLA = "item-cola";
const ITEM_FRIES = "item-fries";
const PRODUCT_COLA = "product-cola";
const PRODUCT_FRIES = "product-fries";

/**
 * A genuine in-memory table store — real insert/update/select against plain
 * arrays, with a real 23505 conflict simulated for restaurant_orders on
 * (tenant_id, client_request_id), the exact same partial unique index
 * openPosOrder already relies on. Every table createGuestOrder's full write
 * path touches (station/pricing resolution, order items, table status,
 * kitchen tickets) is real data, not a per-call stub — the same style as
 * selfnova.server.test.ts's fakeDb, extended with write support.
 */
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
    restaurant_tenants: [
      { id: TENANT, name: "Demo", status: "active", settings: null },
      { id: OTHER_TENANT, name: "Other tenant", status: "active", settings: null },
    ],
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
    ],
    restaurant_menu_items: [
      {
        id: ITEM_COLA,
        menu_id: MENU,
        category_id: CATEGORY,
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

describe("submitGuestOrder — double-submission protection (GEP3)", () => {
  it("D: a fresh submission creates exactly one order and fires it exactly once", async () => {
    const sb = makeFakeSupabase(baseRows());
    const result = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-1",
    });
    expect(result.idempotent).toBe(false);
    expect(sb.store.restaurant_orders).toHaveLength(1);
    expect(sb.store.restaurant_orders[0]).toMatchObject({
      tenant_id: TENANT,
      table_id: TABLE,
      client_request_id: "req-1",
    });
    expect(sb.store.restaurant_order_items).toHaveLength(1);
    expect(sb.store.restaurant_kitchen_tickets).toHaveLength(1);
  });

  it("E/F: submitting the same clientRequestId a second time (double-tap / retry) returns the same order — no second row, no second ticket", async () => {
    const sb = makeFakeSupabase(baseRows());
    const first = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-2",
    });
    const second = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      sessionToken: first.guestSessionToken,
      clientRequestId: "req-2",
    });
    expect(second.id).toBe(first.id);
    expect(second.idempotent).toBe(true);
    expect(sb.store.restaurant_orders).toHaveLength(1);
    expect(sb.store.restaurant_kitchen_tickets).toHaveLength(1);
    expect(sb.store.restaurant_order_items).toHaveLength(1);
  });

  it("browser refresh mid-submission: a third and fourth retry of the same clientRequestId still resolve to the one order", async () => {
    const sb = makeFakeSupabase(baseRows());
    const first = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-3",
    });
    for (let i = 0; i < 2; i++) {
      const retry = await submitGuestOrder(sb, {
        tableId: TABLE,
        lines: [colaLine()],
        sessionToken: first.guestSessionToken,
        clientRequestId: "req-3",
      });
      expect(retry.id).toBe(first.id);
      expect(retry.idempotent).toBe(true);
    }
    expect(sb.store.restaurant_orders).toHaveLength(1);
  });

  it("concurrent confirmation (two tabs/devices racing the same basket): exactly one order wins, the loser recovers via the unique-index conflict, and firing happens exactly once", async () => {
    const sb = makeFakeSupabase(baseRows());
    const [a, b] = await Promise.all([
      submitGuestOrder(sb, { tableId: TABLE, lines: [colaLine()], clientRequestId: "req-race" }),
      submitGuestOrder(sb, { tableId: TABLE, lines: [colaLine()], clientRequestId: "req-race" }),
    ]);
    expect(a.id).toBe(b.id);
    expect([a.idempotent, b.idempotent].sort()).toEqual([false, true]);
    expect(sb.store.restaurant_orders).toHaveLength(1);
    expect(sb.store.restaurant_kitchen_tickets).toHaveLength(1);
  });

  it("a clientRequestId that already resolved to an order on a different table is rejected, never handed back cross-table", async () => {
    const sb = makeFakeSupabase(baseRows());
    await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-cross",
    });
    await expect(
      submitGuestOrder(sb, {
        tableId: OTHER_TABLE,
        lines: [colaLine()],
        clientRequestId: "req-cross",
      }),
    ).rejects.toThrow(/could not be found for this table/);
    expect(sb.store.restaurant_orders).toHaveLength(1);
  });

  it("a fresh clientRequestId on a genuinely new order (guest orders again after a confirmed order) creates a separate second order", async () => {
    const sb = makeFakeSupabase(baseRows());
    const first = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine()],
      clientRequestId: "req-order-1",
    });
    const second = await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine({ menuItemId: ITEM_FRIES, description: "Fries" })],
      sessionToken: first.guestSessionToken,
      clientRequestId: "req-order-2",
    });
    expect(second.id).not.toBe(first.id);
    expect(sb.store.restaurant_orders).toHaveLength(2);
    expect(sb.store.restaurant_kitchen_tickets).toHaveLength(2);
  });

  it("no clientRequestId at all (older client) still places a genuine order — the guard is additive, never required", async () => {
    const sb = makeFakeSupabase(baseRows());
    const result = await submitGuestOrder(sb, { tableId: TABLE, lines: [colaLine()] });
    expect(result.idempotent).toBe(false);
    expect(sb.store.restaurant_orders).toHaveLength(1);
  });

  it("G: an item that became unavailable between menu load and confirmation is rejected — no order is created", async () => {
    const rows = baseRows();
    rows.restaurant_menu_items = rows.restaurant_menu_items.map((i) =>
      i.id === ITEM_COLA ? { ...i, available: false } : i,
    );
    const sb = makeFakeSupabase(rows);
    await expect(
      submitGuestOrder(sb, { tableId: TABLE, lines: [colaLine()], clientRequestId: "req-unavail" }),
    ).rejects.toThrow(/no longer available/);
    expect(sb.store.restaurant_orders).toHaveLength(0);
  });

  it("H: server-side price is always what gets recorded, never a client-proposed unitPrice — proving pricing is re-derived, not trusted", async () => {
    const sb = makeFakeSupabase(baseRows());
    await submitGuestOrder(sb, {
      tableId: TABLE,
      // A tampered/stale client sends a fabricated price far below the real one.
      lines: [colaLine({ unitPrice: 1 })],
      clientRequestId: "req-price",
    });
    expect(sb.store.restaurant_order_items[0].unit_price).toBe(2000);
  });

  it("cross-tenant: a table from a different tenant never sees or touches this tenant's catalogue/orders", async () => {
    const rows = baseRows();
    rows.restaurant_tables = [
      ...rows.restaurant_tables,
      {
        id: "table-other-tenant",
        code: "TX",
        name: "TX",
        tenant_id: OTHER_TENANT,
        property_id: null,
        location_id: null,
        active: true,
        status: "available",
      },
    ];
    const sb = makeFakeSupabase(rows);
    // tenant-2 has no menu items at all, so any line is rejected as not orderable.
    await expect(
      submitGuestOrder(sb, {
        tableId: "table-other-tenant",
        lines: [colaLine()],
        clientRequestId: "req-cross-tenant",
      }),
    ).rejects.toThrow(/no longer available/);
    expect(sb.store.restaurant_orders).toHaveLength(0);
  });

  it("mixed order: kitchen and bar-agnostic items with no station configured are fired together in a single ticket, and the order transitions to sent", async () => {
    const sb = makeFakeSupabase(baseRows());
    await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [colaLine(), colaLine({ menuItemId: ITEM_FRIES, description: "Fries" })],
      clientRequestId: "req-mixed",
    });
    expect(sb.store.restaurant_order_items).toHaveLength(2);
    expect(sb.store.restaurant_order_items.every((i: any) => i.status === "fired")).toBe(true);
    expect(sb.store.restaurant_orders[0].status).toBe("sent");
  });
});
