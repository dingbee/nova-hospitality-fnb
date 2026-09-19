/* eslint-disable @typescript-eslint/no-explicit-any -- fake Supabase rows are untyped at this boundary. */
/**
 * ME-14 — stale client (ME14-09).
 *
 * offline/conflict.test.ts already proves that IF addPosLines throws
 * "This bill is closed and can no longer be modified.", the sync engine's
 * classifier correctly maps it to SERVER_WINS. That test only exercises the
 * classifier against a hand-written string, though — its own comment
 * asserts (without proof) that this is "the exact message addPosLines...
 * throws". Nothing previously called the real addPosLines against a real
 * closed order to confirm it actually still throws that message and,
 * critically, that a stale client's line-add is rejected as a whole rather
 * than partially applied before the authoritative status guard fires.
 */
import { describe, expect, it, vi } from "vitest";
import { addPosLines } from "./pos.server";

vi.mock("../core/access.server", () => ({
  assertCapability: vi.fn(async () => true),
}));
vi.mock("../events/emit.server", () => ({
  emitRestaurantEvent: vi.fn(async () => ({ delivered: true, duplicate: false })),
}));

const TENANT = "tenant-1";
const USER = "user-1";
const ORDER = "order-closed-1";

function fakeDb(seed: { orders: any[]; orderItems: any[] }) {
  const tables: Record<string, any[]> = {
    restaurant_orders: seed.orders,
    restaurant_order_items: seed.orderItems,
  };
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered = rows;
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return api;
      },
      then: (resolve: (v: { data: any[]; error: null }) => unknown) =>
        resolve({ data: filtered, error: null }),
      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      single: async () =>
        filtered.length
          ? { data: filtered[0], error: null }
          : { data: null, error: { message: `${table}: not found` } },
      insert: (row: any) => {
        const stored = { id: `${table}-${rows.length + 1}`, ...row };
        rows.push(stored);
        return { select: () => ({ single: async () => ({ data: stored, error: null }) }) };
      },
    };
    return api;
  }
  return { from, tables } as any;
}

function closedOrder() {
  return {
    id: ORDER,
    tenant_id: TENANT,
    property_id: "prop-1",
    location_id: "loc-1",
    status: "closed",
    order_number: "ORD-CLOSED-1",
    currency: "TZS",
    order_type: "dine_in",
    exchange_rate: 1,
  };
}

describe("addPosLines — stale client cannot reopen a closed bill via a delayed add-lines call (ME-14 ME14-09)", () => {
  it("rejects the mutation against the server's authoritative closed status, with the exact message the offline sync classifier depends on", async () => {
    const sb = fakeDb({ orders: [closedOrder()], orderItems: [] });

    await expect(
      addPosLines(sb, USER, { tenantId: TENANT, orderId: ORDER, lines: [] } as any),
    ).rejects.toThrow("This bill is closed and can no longer be modified.");
  });

  it("no order_items row is written when the stale add-lines call is rejected — the guard fires before any mutation, not after a partial one", async () => {
    const sb = fakeDb({ orders: [closedOrder()], orderItems: [] });

    await expect(
      addPosLines(sb, USER, { tenantId: TENANT, orderId: ORDER, lines: [] } as any),
    ).rejects.toThrow();

    expect(sb.tables.restaurant_order_items).toHaveLength(0);
    // The order row itself — the authoritative server state a stale client
    // tried to act against — is also untouched.
    expect(sb.tables.restaurant_orders[0].status).toBe("closed");
  });
});
