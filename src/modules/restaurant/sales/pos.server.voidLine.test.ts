/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
import { describe, expect, it, vi } from "vitest";

/**
 * Regression for a real operational-integrity gap: voidPosLine corrected the
 * bill and the stock ledger for a voided line, but never told the kitchen/bar
 * that the line it had already fired a ticket for was gone. A line voided
 * after being sent to production left its restaurant_kitchen_ticket_items row
 * sitting at queued/preparing/ready forever — production kept working from a
 * ticket for a line no longer on the bill, and a guest's own order tracker
 * (selforder-tracking.ts's classifyGuestStreams, which treats the ticket as
 * authoritative once a line is fired) kept reporting progress on it.
 *
 * Fixed by cancelKitchenTicketItemsForOrderItems (kitchen.server.ts), called
 * from both voidPosLine and cancelOrder right after the order item itself is
 * voided.
 */

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => {}),
  assertTenantRead: vi.fn(async () => {}),
  getTenantScope: vi.fn(async () => ({})),
  accessibleLocationIds: vi.fn(async () => null),
  NO_MATCH_ID: "00000000-0000-0000-0000-000000000000",
}));
vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn(async () => ({ delivered: true })),
}));
vi.mock("../inventory/reversal.server", () => ({
  reverseMovementsForOrderItem: vi.fn(async () => ({
    reversed: 0,
    alreadyReversed: 0,
    costRestored: 0,
    movementIds: [],
  })),
  reverseMovementsForOrder: vi.fn(async () => ({
    reversed: 0,
    alreadyReversed: 0,
    costRestored: 0,
    movementIds: [],
  })),
}));
vi.mock("./sales.server", () => ({
  recalcOrder: vi.fn(async () => ({ total: 0, location_id: "loc-1" })),
  createOrder: vi.fn(),
  insertLines: vi.fn(),
  transitionOrder: vi.fn(),
}));

import { voidPosLine } from "./pos.server";
import { cancelOrder } from "./cancellation.server";

const TENANT = "tenant-1";
const USER = "user-1";
const ORDER = "order-1";

function fakeDb(tables: Record<string, any[]>) {
  function from(table: string) {
    const rows = tables[table] ?? [];
    let mode: "select" | "update" = "select";
    let patch: any = null;
    const filters: Array<(r: any) => boolean> = [];
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
      not(col: string, _op: string, val: string) {
        const set = new Set(val.replace(/[()]/g, "").split(","));
        filters.push((r) => !set.has(r[col]));
        return api;
      },
      update(p: any) {
        mode = "update";
        patch = p;
        return api;
      },
      maybeSingle: async () => resolve(true),
      single: async () => resolve(true),
      then: (onFulfilled: any, onRejected: any) => resolve(false).then(onFulfilled, onRejected),
    };
    function matched() {
      return rows.filter((r) => filters.every((f) => f(r)));
    }
    async function resolve(wantSingle: boolean) {
      const m = matched();
      if (mode === "update") {
        for (const r of m) Object.assign(r, patch);
      }
      return { data: wantSingle ? (m[0] ?? null) : m, error: null };
    }
    return api;
  }
  return { from };
}

function orderRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: ORDER,
    tenant_id: TENANT,
    order_number: "ORD-1",
    status: "served",
    payment_state: "unpaid",
    table_id: null,
    location_id: "loc-1",
    property_id: "prop-1",
    total: 0,
    paid_total: 0,
    currency: "TZS",
    cancelled_at: null,
    ...overrides,
  };
}

describe("voidPosLine — syncs the kitchen/bar ticket, never leaves a phantom production item", () => {
  it("cancels a still-preparing ticket item for the voided line", async () => {
    const tables = {
      restaurant_order_items: [
        {
          id: "item-1",
          order_id: ORDER,
          description: "Steak",
          quantity: 1,
          line_total: 100,
          line_cost: 0,
          status: "fired",
          tenant_id: TENANT,
        },
      ],
      restaurant_orders: [orderRow()],
      restaurant_kitchen_ticket_items: [
        {
          id: "kti-1",
          ticket_id: "ticket-1",
          order_item_id: "item-1",
          status: "preparing",
          tenant_id: TENANT,
        },
      ],
    };
    const sb = fakeDb(tables);

    await voidPosLine(sb, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      orderItemId: "item-1",
      reason: "Guest changed their mind",
    } as any);

    expect(tables.restaurant_kitchen_ticket_items[0]!.status).toBe("cancelled");
  });

  it("leaves an already-served ticket item alone — a void after service corrects the bill, never rewrites service history", async () => {
    const tables = {
      restaurant_order_items: [
        {
          id: "item-1",
          order_id: ORDER,
          description: "Steak",
          quantity: 1,
          line_total: 100,
          line_cost: 0,
          status: "served",
          tenant_id: TENANT,
        },
      ],
      restaurant_orders: [orderRow()],
      restaurant_kitchen_ticket_items: [
        {
          id: "kti-1",
          ticket_id: "ticket-1",
          order_item_id: "item-1",
          status: "served",
          tenant_id: TENANT,
        },
      ],
    };
    const sb = fakeDb(tables);

    await voidPosLine(sb, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      orderItemId: "item-1",
      reason: "Refund",
    } as any);

    expect(tables.restaurant_kitchen_ticket_items[0]!.status).toBe("served");
  });
});

describe("cancelOrder — whole-order cancellation syncs every live line's ticket item", () => {
  it("cancels tickets for every non-voided line, but leaves the served one alone", async () => {
    const tables = {
      restaurant_orders: [orderRow({ status: "served" })],
      restaurant_payments: [],
      restaurant_order_items: [
        { id: "item-1", order_id: ORDER, status: "preparing", tenant_id: TENANT },
        { id: "item-2", order_id: ORDER, status: "served", tenant_id: TENANT },
      ],
      restaurant_stock_movements: [],
      restaurant_tables: [],
      restaurant_kitchen_ticket_items: [
        {
          id: "kti-1",
          ticket_id: "t-1",
          order_item_id: "item-1",
          status: "preparing",
          tenant_id: TENANT,
        },
        {
          id: "kti-2",
          ticket_id: "t-2",
          order_item_id: "item-2",
          status: "served",
          tenant_id: TENANT,
        },
      ],
    };
    const sb = fakeDb(tables);

    await cancelOrder(sb, USER, {
      tenantId: TENANT,
      orderId: ORDER,
      reason: "Kitchen error",
    } as any);

    expect(tables.restaurant_kitchen_ticket_items[0]!.status).toBe("cancelled");
    expect(tables.restaurant_kitchen_ticket_items[1]!.status).toBe("served");
  });
});
