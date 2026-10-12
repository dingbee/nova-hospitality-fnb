/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase query boundary. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../core/access.server", () => ({ assertTenantRead: vi.fn() }));
vi.mock("./locations.server", () => ({
  locationNameMap: vi.fn(async () => new Map()),
}));

import { incomingIndex, listStockPositions } from "./positions.server";

const TENANT = "11111111-1111-4111-8111-111111111111";

function fakeSupabase(results: Record<string, unknown>) {
  const calls: Array<{
    table: string;
    filters: Array<[string, string, unknown]>;
  }> = [];
  return {
    calls,
    supabase: {
      from(table: string) {
        const call = { table, filters: [] as Array<[string, string, unknown]> };
        calls.push(call);
        const query: any = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            call.filters.push(["eq", column, value]);
            return query;
          },
          in: (column: string, value: unknown) => {
            call.filters.push(["in", column, value]);
            return query;
          },
          order: () => query,
          limit: () => query,
          ilike: () => query,
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve, reject),
        };
        return query;
      },
    } as any,
  };
}

describe("incomingIndex — stock-position inbound integrity", () => {
  it("counts only positive outstanding quantities from open purchase orders", async () => {
    const fake = fakeSupabase({
      restaurant_purchase_orders: {
        data: [
          { id: "po-1", status: "approved" },
          { id: "po-2", status: "partially_received" },
        ],
        error: null,
      },
      restaurant_purchase_order_items: {
        data: [
          { inventory_item_id: "item-1", quantity: 10, received_quantity: 4 },
          { inventory_item_id: "item-1", quantity: 3, received_quantity: 3 },
          { inventory_item_id: "item-2", quantity: 4, received_quantity: 5 },
          { inventory_item_id: null, quantity: 8, received_quantity: 0 },
        ],
        error: null,
      },
    });

    const incoming = await incomingIndex(fake.supabase, TENANT);

    expect(incoming.get("item-1")).toBe(6);
    expect(incoming.has("item-2")).toBe(false);
    expect(incoming.has("item-3")).toBe(false);
    expect(
      fake.calls.find((c) => c.table === "restaurant_purchase_orders")?.filters,
    ).toContainEqual(["in", "status", ["submitted", "approved", "partially_received"]]);
    expect(
      fake.calls.find((c) => c.table === "restaurant_purchase_order_items")?.filters,
    ).toContainEqual(["eq", "tenant_id", TENANT]);
  });

  it("fails visibly instead of reporting zero inbound when open purchase orders cannot be read", async () => {
    const fake = fakeSupabase({
      restaurant_purchase_orders: {
        data: null,
        error: { message: "orders unavailable" },
      },
    });

    await expect(incomingIndex(fake.supabase, TENANT)).rejects.toThrow(/orders unavailable/i);
  });

  it("fails closed on malformed non-finite inbound quantities instead of poisoning totals with NaN", async () => {
    const fake = fakeSupabase({
      restaurant_purchase_orders: { data: [{ id: "po-1" }], error: null },
      restaurant_purchase_order_items: {
        data: [{ inventory_item_id: "item-1", quantity: Number.NaN, received_quantity: 0 }],
        error: null,
      },
    });

    await expect(incomingIndex(fake.supabase, TENANT)).rejects.toThrow(/invalid purchase-order quantity/i);
  });

  it("fails visibly instead of reporting zero inbound when purchase-order lines cannot be read", async () => {
    const fake = fakeSupabase({
      restaurant_purchase_orders: { data: [{ id: "po-1" }], error: null },
      restaurant_purchase_order_items: {
        data: null,
        error: { message: "lines unavailable" },
      },
    });

    await expect(incomingIndex(fake.supabase, TENANT)).rejects.toThrow(/lines unavailable/i);
  });

  it("fails closed when active reservation reads fail", async () => {
    const fake = fakeSupabase({
      restaurant_inventory_items: { data: [], error: null },
      restaurant_stock_positions_v: { data: [], error: null },
      restaurant_stock_reservations: { data: null, error: { message: "reservations unavailable" } },
      restaurant_purchase_orders: { data: [], error: null },
    });

    await expect(listStockPositions(fake.supabase, "user-1", {
      tenantId: TENANT,
      limit: 20,
      lowOnly: false,
    } as any)).rejects.toThrow(/active reservations.*reservations unavailable/i);
  });

  it("fails closed when the stock ledger view cannot be read", async () => {
    const fake = fakeSupabase({
      restaurant_inventory_items: { data: [], error: null },
      restaurant_stock_positions_v: { data: null, error: { message: "ledger unavailable" } },
      restaurant_stock_reservations: { data: [], error: null },
      restaurant_purchase_orders: { data: [], error: null },
    });

    await expect(listStockPositions(fake.supabase, "user-1", {
      tenantId: TENANT,
      limit: 20,
      lowOnly: false,
    } as any)).rejects.toThrow(/stock ledger.*ledger unavailable/i);
  });
});
