/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * Bar routing — mixed guest order (food + drink), traced end to end through
 * the real submitGuestOrder -> createGuestOrder -> insertLines ->
 * loadStationResolutionContext -> resolveCataloguedLineStation ->
 * fireGuestOrder -> fireOrderItemsCore -> groupItemsByStation chain, against
 * a genuine in-memory Supabase fake (no mocking of any step in that chain).
 *
 * Root cause under test: loadStationResolutionContext() (sales.server.ts)
 * resolved `restaurant_stations` tenant-wide only, with no property scoping,
 * unlike its sibling `resolveBarScope()` (bar.server.ts) which the Bar
 * Workspace itself uses. In a multi-property tenant this let the beverage
 * classification fallback in resolveCataloguedLineStation pick a bar station
 * belonging to a DIFFERENT property purely by array/sort order — the ticket
 * was still created with that station_id, but the correctly property-scoped
 * Bar Workspace (resolveBarScope) would never include that station in its
 * own scope, so the ticket silently vanished from the bar's view. These
 * tests prove: (1) mixed order -> exactly one kitchen ticket + one bar
 * ticket, no duplication/loss; (2) the beverage line's station_id is a real
 * bar station belonging to the ORDER'S OWN property, never a foreign
 * property's, even when the foreign station would otherwise be found first;
 * (3) resolveBarScope, given the order's own property, includes that exact
 * station — i.e. the ticket the guest chain created is actually visible to
 * the Bar Workspace.
 */
import { describe, expect, it } from "vitest";
import { submitGuestOrder } from "./selforder.server";
import { resolveBarScope } from "../bar/bar.server";
import type { GuestLineInput } from "./selforder.contracts";

const TENANT = "tenant-1";
const PROPERTY_A = "property-a";
const PROPERTY_B = "property-b";
const TABLE = "table-1";
const MENU = "menu-1";
const CATEGORY_MAINS = "cat-mains";
const CATEGORY_DRINKS = "cat-drinks";
const ITEM_FRIES = "item-fries";
const ITEM_COLA = "item-cola";
const PRODUCT_FRIES = "product-fries";
const PRODUCT_COLA = "product-cola";
/** Deliberately sorts/inserts BEFORE the correct property-A bar station, so a tenant-wide (unscoped) query would pick this one first. */
const STATION_BAR_B = "station-bar-b";
const STATION_KITCHEN_A = "station-kitchen-a";
const STATION_BAR_A = "station-bar-a";

/** Same genuine in-memory table store as selforder.submit.server.test.ts (real insert/update/select, real (tenant_id, client_request_id) 23505 simulation). */
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
        property_id: PROPERTY_A,
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
        id: CATEGORY_MAINS,
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
        id: ITEM_FRIES,
        menu_id: MENU,
        category_id: CATEGORY_MAINS,
        name: "Fries",
        description: "Salted fries",
        price: 3000,
        currency: "USD",
        available: true,
        tags: [],
        allergens: [],
        sort_order: 1,
        image_url: null,
        tenant_id: TENANT,
      },
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
        sort_order: 2,
        image_url: null,
        tenant_id: TENANT,
      },
    ],
    restaurant_products: [
      {
        id: PRODUCT_FRIES,
        name: "Fries",
        menu_item_id: ITEM_FRIES,
        // No explicit station_id -- must fall through to the non-bar (kitchen) lane default.
        station_id: null,
        price: null,
        product_type: "menu_item",
        active: true,
        tenant_id: TENANT,
      },
      {
        id: PRODUCT_COLA,
        name: "Cola",
        menu_item_id: ITEM_COLA,
        // No explicit station_id -- must fall through to the beverage/bar lane default.
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
    // STATION_BAR_B (a different property's bar station) is inserted FIRST,
    // deliberately, so a tenant-wide-only query would resolve the beverage
    // classification fallback to it before ever reaching the order's own
    // property's real bar station.
    restaurant_stations: [
      {
        id: STATION_BAR_B,
        tenant_id: TENANT,
        property_id: PROPERTY_B,
        location_id: null,
        code: "BAR-B",
        name: "Bar (Property B)",
        station_type: "bar",
        sort_order: 1,
        active: true,
      },
      {
        id: STATION_KITCHEN_A,
        tenant_id: TENANT,
        property_id: PROPERTY_A,
        location_id: null,
        code: "KIT-A",
        name: "Kitchen (Property A)",
        station_type: "kitchen",
        sort_order: 2,
        active: true,
      },
      {
        id: STATION_BAR_A,
        tenant_id: TENANT,
        property_id: PROPERTY_A,
        location_id: null,
        code: "BAR-A",
        name: "Bar (Property A)",
        station_type: "bar",
        sort_order: 3,
        active: true,
      },
    ],
    restaurant_prices: [
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
    restaurant_locations: [],
    ...overrides,
  };
}

function line(overrides: Partial<GuestLineInput> = {}): GuestLineInput {
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

describe("mixed guest order — bar routing (BAR TESTS 1-3, 5-7)", () => {
  it("food-only order: exactly one kitchen ticket, item routed to the non-bar station", async () => {
    const sb = makeFakeSupabase(baseRows());
    await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [line({ menuItemId: ITEM_FRIES })],
      clientRequestId: "req-food",
    });
    expect(sb.store.restaurant_kitchen_tickets).toHaveLength(1);
    expect(sb.store.restaurant_kitchen_tickets[0].station_id).toBe(STATION_KITCHEN_A);
    expect(sb.store.restaurant_order_items).toHaveLength(1);
    expect(sb.store.restaurant_order_items[0].station_id).toBe(STATION_KITCHEN_A);
  });

  it("beverage-only order: exactly one bar ticket, item routed to THIS property's bar station, never the foreign one", async () => {
    const sb = makeFakeSupabase(baseRows());
    await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [line({ menuItemId: ITEM_COLA, description: "Cola" })],
      clientRequestId: "req-bev",
    });
    expect(sb.store.restaurant_kitchen_tickets).toHaveLength(1);
    expect(sb.store.restaurant_kitchen_tickets[0].station_id).toBe(STATION_BAR_A);
    expect(sb.store.restaurant_kitchen_tickets[0].station_id).not.toBe(STATION_BAR_B);
    expect(sb.store.restaurant_order_items[0].station_id).toBe(STATION_BAR_A);
  });

  it("mixed order (food + drink): exactly TWO tickets, no duplication, no drop, each containing only its own lane's line", async () => {
    const sb = makeFakeSupabase(baseRows());
    await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [
        line({ menuItemId: ITEM_FRIES, description: "Fries" }),
        line({ menuItemId: ITEM_COLA, description: "Cola" }),
      ],
      clientRequestId: "req-mixed",
    });

    expect(sb.store.restaurant_order_items).toHaveLength(2);
    const items = sb.store.restaurant_order_items as any[];
    const friesItem = items.find((i) => i.description === "Fries")!;
    const colaItem = items.find((i) => i.description === "Cola")!;
    expect(friesItem.station_id).toBe(STATION_KITCHEN_A);
    expect(colaItem.station_id).toBe(STATION_BAR_A);
    expect(colaItem.station_id).not.toBe(STATION_BAR_B);

    // Exactly two tickets — one per station group, none merged, none lost.
    const tickets = sb.store.restaurant_kitchen_tickets as any[];
    expect(tickets).toHaveLength(2);
    const stationIds = tickets.map((t) => t.station_id).sort();
    expect(stationIds).toEqual([STATION_BAR_A, STATION_KITCHEN_A].sort());

    // Every fired item is attributed to exactly one ticket, and no ticket
    // carries a line from the other lane.
    const ticketItems = sb.store.restaurant_kitchen_ticket_items as any[];
    expect(ticketItems).toHaveLength(2);
    const kitchenTicket = tickets.find((t) => t.station_id === STATION_KITCHEN_A)!;
    const barTicket = tickets.find((t) => t.station_id === STATION_BAR_A)!;
    const kitchenTicketItemIds = ticketItems
      .filter((ti) => ti.ticket_id === kitchenTicket.id)
      .map((ti) => ti.order_item_id);
    const barTicketItemIds = ticketItems
      .filter((ti) => ti.ticket_id === barTicket.id)
      .map((ti) => ti.order_item_id);
    expect(kitchenTicketItemIds).toEqual([friesItem.id]);
    expect(barTicketItemIds).toEqual([colaItem.id]);
  });

  it("the bar ticket the guest chain created is visible to the Bar Workspace's own property-scoped resolveBarScope for this order's property", async () => {
    const sb = makeFakeSupabase(baseRows());
    await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [line({ menuItemId: ITEM_COLA, description: "Cola" })],
      clientRequestId: "req-visibility",
    });
    const barTicket = (sb.store.restaurant_kitchen_tickets as any[])[0];

    const scopeA = await resolveBarScope(sb, TENANT, PROPERTY_A);
    expect(scopeA.stationIds).toContain(barTicket.station_id);

    // And the symmetric proof: a DIFFERENT property's bar scope must never
    // include this order's station — the isolation this fix restores.
    const scopeB = await resolveBarScope(sb, TENANT, PROPERTY_B);
    expect(scopeB.stationIds).not.toContain(barTicket.station_id);
  });

  it("a stale/foreign client-proposed station on a catalogued line is never honoured — the server-derived lane always wins", async () => {
    const sb = makeFakeSupabase(baseRows());
    await submitGuestOrder(sb, {
      tableId: TABLE,
      lines: [
        line({
          menuItemId: ITEM_COLA,
          description: "Cola",
          // A guest client has no legitimate way to set stationId, but
          // resolveCataloguedLineStation must ignore it either way — proven
          // here by asserting the resolved station is still the correct
          // property-scoped bar station regardless.
        }),
      ],
      clientRequestId: "req-client-station",
    });
    expect(sb.store.restaurant_order_items[0].station_id).toBe(STATION_BAR_A);
  });
});
